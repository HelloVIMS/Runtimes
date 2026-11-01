import { randomUUID } from "node:crypto";
import path from "node:path";
import { Store, identifier, text } from "./store.ts";
import { Workspaces } from "./workspaces.ts";
import { queuedRunsInDeliveryOrder } from "./t3/QueuedRunOrder.ts";
import {
  handoffBudget,
  handoffCoverage,
  historicalMessage,
  historyCost,
  selectHistory,
  resolveHandoffTokenCap,
} from "./t3/handoffBudget.ts";
import { resolvePendingHandoff } from "./t3/handoff.ts";
import {
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./t3/inbox.ts";
import { resolveVisibleWorktreeSetup } from "./t3/worktreeSetup.ts";
import { coalesceLiveUpdatedEvents } from "./t3/liveEvents.ts";
import type {
  EnvironmentThreadShell,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ThreadStreamItem,
  WorktreeSetupSnapshot,
} from "./t3/contracts.ts";
import type {
  DriverItem,
  NativeDriver,
  QueueInput,
  Run,
  StoredItem,
  Thread,
} from "./types.ts";
const active = new Set(["preparing", "running", "cancel_requested"]);
const now = () => new Date().toISOString();
/** A local VIMS composition layer. T3 supplies copied algorithms, not a running service. */
export class CoderCore {
  readonly store: Store;
  readonly workspaces: Workspaces;
  private drivers = new Map<string, NativeDriver>();
  private controllers = new Map<string, AbortController>();
  constructor(
    readonly stateDirectory: string,
    drivers: readonly NativeDriver[] = [],
  ) {
    this.workspaces = new Workspaces(
      path.join(path.resolve(stateDirectory), "worktrees"),
    );
    for (const driver of drivers) {
      identifier(driver.id);
      if (this.drivers.has(driver.id)) throw new Error("duplicate driver id");
      if (driver.contextMode !== "portable")
        throw new Error(
          "only explicit portable-context adapters are supported",
        );
      if (
        driver.contextWindow !== undefined &&
        (!Number.isSafeInteger(driver.contextWindow) ||
          driver.contextWindow < 1024)
      )
        throw new Error("invalid driver context window");
      this.drivers.set(driver.id, driver);
    }
    this.store = new Store(path.resolve(stateDirectory));
  }
  async createThread(
    commandId: string,
    input: { repository: string; title: string; baseRef?: string },
  ): Promise<Thread> {
    const repository = await this.workspaces.repository(
      text(input.repository, "repository", 4096),
    );
    const value = {
      repository,
      title: text(input.title, "title", 256),
      baseRef: text(input.baseRef ?? "HEAD", "base ref", 512),
    };
    return this.store.command(
      commandId,
      { type: "thread.create", ...value },
      () => {
        const at = now();
        const thread: Thread = {
          id: randomUUID(),
          ...value,
          worktree: null,
          createdAt: at,
          updatedAt: at,
        };
        this.store.putThread(thread);
        this.store.event(thread.id, null, "thread.created", thread);
        return thread;
      },
    );
  }
  queue(commandId: string, input: QueueInput): Run {
    const value = {
      threadId: identifier(input.threadId),
      driverId: identifier(input.driverId),
      model: text(input.model, "model", 256),
      prompt: text(input.prompt, "prompt", 32768),
      automaticCompletion: input.automaticCompletion === true,
    };
    if (!this.drivers.has(value.driverId))
      throw new Error("driver is not registered");
    return this.store.command(
      commandId,
      { type: "run.queue", ...value },
      () => {
        const thread = this.store.thread(value.threadId);
        const runs = this.store.runs(thread.id);
        const ordinal = (runs.at(-1)?.ordinal ?? 0) + 1;
        const id = randomUUID();
        const at = now();
        const run: Run = {
          id,
          threadId: thread.id,
          ordinal,
          userMessageId: randomUUID(),
          queuePosition: ordinal,
          providerInstanceId: value.driverId,
          modelSelection: { instanceId: value.driverId, model: value.model },
          prompt: value.prompt,
          status: "waiting",
          approved: false,
          automaticCompletion: value.automaticCompletion,
          createdAt: at,
          startedAt: null,
          completedAt: null,
          contextHandoffId: null,
          before: null,
          after: null,
          error: null,
        };
        this.store.putRun(run);
        this.store.putThread({ ...thread, updatedAt: at });
        this.store.event(thread.id, id, "run.queued", run);
        this.store.event(thread.id, id, "item", {
          id: run.userMessageId,
          threadId: thread.id,
          runId: id,
          providerThreadId: value.driverId,
          status: "completed",
          type: "user_message",
          text: run.prompt,
        } satisfies StoredItem);
        return run;
      },
    );
  }
  /** Host must authenticate the human and show the exact task/model before calling. */
  approve(commandId: string, runId: string): Run {
    return this.store.command(
      commandId,
      { type: "run.approve", runId: identifier(runId) },
      () => {
        const run = this.store.run(runId);
        if (run.status !== "waiting")
          throw new Error("only a waiting submission can be approved");
        const updated: Run = { ...run, approved: true, status: "queued" };
        this.store.putRun(updated);
        this.store.event(run.threadId, runId, "run.approved", { runId });
        return updated;
      },
    );
  }
  reorder(
    commandId: string,
    threadId: string,
    runIds: readonly string[],
  ): string[] {
    identifier(threadId);
    runIds.forEach(identifier);
    return this.store.command(
      commandId,
      { type: "queue.reorder", threadId, runIds },
      () => {
        const queued = this.store
          .runs(threadId)
          .filter((run) => run.status === "queued" || run.status === "waiting");
        if (
          new Set(runIds).size !== runIds.length ||
          runIds.length !== queued.length ||
          queued.some((run) => !runIds.includes(run.id))
        )
          throw new Error("reorder must name every pending run exactly once");
        for (const run of queued)
          this.store.putRun({ ...run, queuePosition: runIds.indexOf(run.id) });
        this.store.event(threadId, null, "queue.reordered", { runIds });
        return [...runIds];
      },
    );
  }
  cancel(commandId: string, runId: string): Run {
    const result = this.store.command(
      commandId,
      { type: "run.cancel", runId: identifier(runId) },
      () => {
        const run = this.store.run(runId);
        if (
          ![
            "waiting",
            "queued",
            "preparing",
            "running",
            "cancel_requested",
          ].includes(run.status)
        )
          return run;
        const status = active.has(run.status)
          ? "cancel_requested"
          : "cancelled";
        const updated: Run = {
          ...run,
          status,
          completedAt: status === "cancelled" ? now() : null,
        };
        this.store.putRun(updated);
        this.store.event(run.threadId, runId, "run.cancel-requested", {
          status,
        });
        return updated;
      },
    );
    if (result.status === "cancel_requested")
      this.controllers.get(runId)?.abort(new Error("cancel requested"));
    return result;
  }
  /** No automatic replay after process failure. The host must first verify the old executor stopped. */
  reconcileInterrupted(
    commandId: string,
    runId: string,
    verifiedExecutorStopped: boolean,
  ): Run {
    if (!verifiedExecutorStopped || this.controllers.has(runId))
      throw new Error("executor must be independently confirmed stopped");
    return this.store.command(
      commandId,
      { type: "run.reconcile", runId: identifier(runId) },
      () => {
        const run = this.store.run(runId);
        if (!active.has(run.status)) throw new Error("run is not unresolved");
        const updated: Run = {
          ...run,
          status: "interrupted",
          completedAt: now(),
          error:
            "Executor stopped; side effects may have happened. Review before submitting a new run.",
        };
        this.store.putRun(updated);
        this.store.event(run.threadId, runId, "run.interrupted", {
          error: updated.error,
        });
        return updated;
      },
    );
  }
  private claim(threadId: string): Run | null {
    return this.store.transaction(() => {
      const runs = this.store.runs(threadId);
      if (runs.some((run) => active.has(run.status))) return null;
      // Directly copied T3 priority/queue-position/ordinal ordering.
      const ordered = queuedRunsInDeliveryOrder({
        runs,
        messages: runs.map((run) => ({
          id: run.userMessageId,
          ...(run.automaticCompletion ? { delegatedCompletion: {} } : {}),
        })),
      });
      const first = ordered[0];
      if (!first) return null;
      const run = runs.find((candidate) => candidate.id === first.id)!;
      if (!run.approved)
        throw new Error("unapproved run reached executable queue");
      const claimed: Run = { ...run, status: "preparing", startedAt: now() };
      this.store.putRun(claimed);
      this.store.event(threadId, run.id, "run.claimed", { runId: run.id });
      return claimed;
    });
  }
  private priorItems(run: Run): { items: StoredItem[]; omitted: number } {
    const allowed = new Set(
      this.store
        .runs(run.threadId)
        .filter(
          (prior) => prior.ordinal < run.ordinal && prior.startedAt !== null,
        )
        .map((prior) => prior.id),
    );
    // Bound memory while preserving the original user constraint and recent activity.
    const rows = this.store.db
      .prepare(
        "SELECT e.payload FROM events e JOIN runs r ON e.run_id=r.id WHERE e.thread_id=? AND e.kind='item' AND r.ordinal<? AND json_extract(r.body,'$.startedAt') IS NOT NULL ORDER BY e.sequence DESC LIMIT 2001",
      )
      .all(run.threadId, run.ordinal);
    const recent = rows
      .map((row) => JSON.parse(String(row.payload)) as StoredItem)
      .filter((item) => item.runId !== null && allowed.has(item.runId))
      .reverse();
    const firstRow = this.store.db
      .prepare(
        "SELECT payload FROM events WHERE thread_id=? AND kind='item' ORDER BY sequence LIMIT 1",
      )
      .get(run.threadId);
    const first = firstRow
      ? (JSON.parse(String(firstRow.payload)) as StoredItem)
      : null;
    if (
      first &&
      first.runId !== null &&
      allowed.has(first.runId) &&
      !recent.some((item) => item.id === first.id)
    )
      recent.unshift(first);
    const totalRows = this.store.db
      .prepare(
        "SELECT run_id,COUNT(*) AS count FROM events WHERE thread_id=? AND kind='item' GROUP BY run_id",
      )
      .all(run.threadId);
    const total = totalRows.reduce(
      (sum, row) =>
        sum + (allowed.has(String(row.run_id)) ? Number(row.count) : 0),
      0,
    );
    return { items: recent, omitted: Math.max(0, total - recent.length) };
  }
  buildHandoff(runId: string) {
    const run = this.store.run(runId);
    const driver = this.drivers.get(run.providerInstanceId);
    if (!driver) throw new Error("driver is not registered");
    const prior = this.priorItems(run);
    if (!prior.items.length)
      return {
        messages: [] as OrchestrationV2HistoricalMessage[],
        context: "",
        omittedItems: prior.omitted,
        omittedItemIds: [] as string[],
        budget: 0,
      };
    const messages = prior.items
      .map(historicalMessage)
      .filter(
        (item): item is OrchestrationV2HistoricalMessage => item !== null,
      );
    const budget = handoffBudget({
      tokenCap: resolveHandoffTokenCap(),
      userText: run.prompt,
      attachments: [],
      providerThread: { id: run.providerInstanceId, contextUsage: null },
      nativeContextEstimate: 0,
      modelContextWindow: driver.contextWindow,
    });
    const coverage = handoffCoverage({
      threadId: run.threadId,
      coveredRunOrdinals: { from: 1, to: run.ordinal - 1 },
      items: prior.items,
    });
    const selected = selectHistory({
      messages,
      coverage,
      omittedItems: prior.omitted + prior.items.length - messages.length,
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget)
      throw new Error(
        "model context is too small even for handoff coverage; choose a larger model or shorten the prompt",
      );
    return { ...selected, budget };
  }
  async executeNext(threadId: string): Promise<Run | null> {
    this.store.thread(threadId);
    const claimed = this.claim(threadId);
    if (!claimed) return null;
    const controller = new AbortController();
    this.controllers.set(claimed.id, controller);
    let produced = 0;
    let itemCount = 0;
    let failed: string | null = null;
    let workspaceReady = false;
    try {
      let thread = this.store.thread(threadId);
      const cwd = await this.workspaces.ensure(thread);
      thread = { ...thread, worktree: cwd, updatedAt: now() };
      this.store.transaction(() => {
        this.store.putThread(thread);
        this.store.event(threadId, claimed.id, "workspace.ready", { cwd });
      });
      workspaceReady = true;
      controller.signal.throwIfAborted();
      const before = await this.workspaces.capture(
        thread,
        claimed.id,
        "before",
      );
      const handoff = this.buildHandoff(claimed.id);
      this.store.transaction(() => {
        const run = this.store.run(claimed.id);
        if (run.status === "cancel_requested")
          throw new Error("cancel requested");
        this.store.putRun({
          ...run,
          status: "running",
          before,
          contextHandoffId: handoff.messages.length ? randomUUID() : null,
        });
        this.store.event(threadId, run.id, "handoff.selected", {
          itemIds: handoff.messages.map((item) => item.itemId),
          omittedItemIds: handoff.omittedItemIds,
          omittedItems: handoff.omittedItems,
          budget: handoff.budget,
        });
        this.store.event(threadId, run.id, "run.started", { before });
      });
      const driver = this.drivers.get(claimed.providerInstanceId);
      if (!driver) throw new Error("driver is no longer registered");
      await driver.run(
        {
          runId: claimed.id,
          threadId,
          cwd,
          model: claimed.modelSelection.model,
          prompt: claimed.prompt,
          history: handoff.messages,
          historyContext: handoff.context,
        },
        (item: DriverItem) => {
          controller.signal.throwIfAborted();
          const data = JSON.stringify(item);
          produced += Buffer.byteLength(data);
          itemCount++;
          if (produced > 1024 * 1024 || itemCount > 2000)
            throw new Error("driver event budget exceeded");
          if (
            ![
              "assistant_message",
              "command_execution",
              "file_change",
              "proposed_plan",
            ].includes(item.type)
          )
            throw new Error("unsupported driver item");
          const stored = {
            ...item,
            id: randomUUID(),
            threadId,
            runId: claimed.id,
            providerThreadId: claimed.providerInstanceId,
            status: "completed",
          } as StoredItem;
          this.store.transaction(() =>
            this.store.event(threadId, claimed.id, "item", stored),
          );
        },
        controller.signal,
      );
    } catch (error) {
      failed = error instanceof Error ? error.message : "native driver failed";
    } finally {
      let after: string | null = null;
      if (workspaceReady)
        try {
          after = await this.workspaces.capture(
            this.store.thread(threadId),
            claimed.id,
            "after",
          );
        } catch (error) {
          failed =
            failed ??
            `checkpoint capture failed: ${error instanceof Error ? error.message : "unknown error"}`;
        }
      this.store.transaction(() => {
        const current = this.store.run(claimed.id);
        const status =
          controller.signal.aborted || current.status === "cancel_requested"
            ? "cancelled"
            : failed
              ? "failed"
              : "completed";
        const updated: Run = {
          ...current,
          status,
          after,
          error: failed?.slice(0, 8192) ?? null,
          completedAt: now(),
        };
        this.store.putRun(updated);
        this.store.putThread({
          ...this.store.thread(threadId),
          updatedAt: now(),
        });
        this.store.event(threadId, claimed.id, "run.finished", {
          status,
          after,
          error: updated.error,
        });
      });
      this.controllers.delete(claimed.id);
    }
    return this.store.run(claimed.id);
  }
  async review(runId: string) {
    const run = this.store.run(runId);
    if (!run.before || !run.after)
      throw new Error("run does not have both checkpoints");
    return this.workspaces.review(
      this.store.thread(run.threadId),
      run.before,
      run.after,
    );
  }
  /** Bounded host API matching the history references in copied handoff coverage. */
  vims_thread_read(input: {
    threadId: string;
    view?: "activity";
    limit?: number;
    afterPosition?: number;
    maxCharsPerItem?: number;
    itemId?: string;
    textOffset?: number;
  }) {
    this.store.thread(input.threadId);
    const max = input.maxCharsPerItem ?? 4000;
    if (!Number.isSafeInteger(max) || max < 1 || max > 16000)
      throw new Error("invalid text limit");
    const offset = input.textOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("invalid text offset");
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid item limit");
    const after = input.afterPosition ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("invalid item cursor");
    if (input.itemId !== undefined) identifier(input.itemId);
    const rows = input.itemId
      ? this.store.db
          .prepare(
            "SELECT sequence,payload FROM events WHERE thread_id=? AND kind='item' AND json_extract(payload,'$.id')=? ORDER BY sequence LIMIT 1",
          )
          .all(input.threadId, input.itemId)
      : this.store.db
          .prepare(
            "SELECT sequence,payload FROM events WHERE thread_id=? AND kind='item' AND sequence>? ORDER BY sequence LIMIT ?",
          )
          .all(input.threadId, after, limit + 1);
    const matching = rows.map((row) => ({
      position: Number(row.sequence),
      item: JSON.parse(String(row.payload)) as StoredItem,
    }));
    const selected = matching.slice(0, limit);
    const items = selected.map(({ position, item }) => {
      const full = historicalMessage(item)?.text ?? "";
      const start = input.itemId ? offset : 0;
      return {
        position,
        itemId: item.id,
        runId: item.runId,
        kind: item.type,
        text: full.slice(start, start + max),
        textTruncated: start + max < full.length,
        nextTextOffset: start + max < full.length ? start + max : null,
      };
    });
    return {
      items,
      hasMore: matching.length > limit,
      nextPosition: items.at(-1)?.position ?? after,
    };
  }
  liveBatch(threadId: string, after = 0) {
    const events = this.store.events(threadId, after, 100);
    const batch: OrchestrationV2ThreadStreamItem[] = events.map((event) => ({
      kind: "event",
      sequence: event.sequence,
      event: {
        threadId,
        runId: event.runId,
        type: event.kind === "item" ? "turn-item.updated" : event.kind,
        payload:
          event.kind === "item"
            ? (event.payload as OrchestrationV2ThreadStreamItem["event"]["payload"])
            : { id: String(event.sequence) },
      },
    }));
    return coalesceLiveUpdatedEvents(batch);
  }
  handoffPreview(threadId: string, driverId: string, model: string) {
    const runs = this.store.runs(threadId);
    return resolvePendingHandoff(
      {
        runs,
        visibleTurnItems: runs.filter((run) => run.startedAt !== null),
        messages: [],
        providerTurns: [],
        attempts: [],
      },
      { instanceId: driverId, model },
      [...this.drivers.values()].map((driver) => ({
        instanceId: driver.id,
        driver: driver.id,
      })),
    );
  }
  workspaceProgress(threadId: string): WorktreeSetupSnapshot | null {
    const thread = this.store.thread(threadId);
    const run = this.store.runs(threadId).at(-1);
    if (!run) return null;
    const recorded: WorktreeSetupSnapshot = {
      sequence: run.ordinal,
      phase: run.status === "preparing" ? "running" : "done",
      stages: [
        { id: "worktree", status: thread.worktree ? "done" : "pending" },
        {
          id: "agent",
          status:
            run.status === "failed"
              ? "failed"
              : run.startedAt
                ? "done"
                : "pending",
        },
      ],
    };
    return resolveVisibleWorktreeSetup({
      live: null,
      recorded,
      turnStarted: run.startedAt !== null,
      followUpSent: false,
    });
  }
  inbox() {
    const shells = this.store.threads().map((thread) => {
      const runs = this.store.runs(thread.id);
      const latest = runs.at(-1) ?? null;
      const current = runs.find((run) => active.has(run.status));
      const shell: EnvironmentThreadShell & { title: string } = {
        id: thread.id,
        title: thread.title,
        environmentId: "vims-local",
        createdAt: thread.createdAt,
        unsettledAt: thread.updatedAt,
        hasPendingApprovals: runs.some((run) => run.status === "waiting"),
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        interactionMode: "execute",
        latestRun: latest
          ? {
              runId: latest.id,
              status: latest.status,
              requestedAt: latest.createdAt,
              completedAt: latest.completedAt,
            }
          : null,
        runtime: current
          ? {
              status:
                current.status === "cancel_requested"
                  ? "running"
                  : current.status,
              activeRunId: current.id,
            }
          : null,
      };
      return shell;
    });
    return {
      working: sortWorkingThreadsBySend(shells.filter(isThreadWorking)),
      attention: sortInboxThreadsByReturn(
        shells.filter((shell) => !isThreadWorking(shell)),
      ),
    };
  }
  close(): void {
    if (this.controllers.size)
      throw new Error("cannot close while native runs are active");
    this.store.close();
  }
}
