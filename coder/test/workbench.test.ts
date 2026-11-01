import { CoderCore } from "../src/core.ts";
import { request as rawRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { startWorkbench } from "../src/workbench.ts";
import { fixture } from "./fixtures.ts";
import type { NativeDriver } from "../src/types.ts";
const driver: NativeDriver = {
  id: "native",
  contextMode: "portable",
  async run(_turn, emit) {
    emit({
      type: "assistant_message",
      text: "<script>globalThis.pwned=true</script> literal output",
    });
  },
};
async function setup(native: NativeDriver = driver) {
  const f = await fixture([native]);
  const wb = await startWorkbench({
    core: f.core,
    projects: [{ id: "project", name: "Allowed project", repository: f.repo }],
    profiles: [
      {
        id: "profile",
        name: "Native test",
        driverId: native.id,
        model: "test",
      },
    ],
  });
  const headers = {
    Authorization: "Bearer " + wb.token,
    "Content-Type": "application/json",
  };
  const post = (data: unknown, extra: Record<string, string> = {}) =>
    fetch(wb.url + "/api/command", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(data),
    });
  return {
    ...f,
    wb,
    headers,
    post,
    cleanup: async () => {
      await wb.close();
      await f.cleanup();
    },
  };
}
async function queue(f: Awaited<ReturnType<typeof setup>>) {
  const create = await f.post({
    type: "thread.create",
    commandId: "create",
    projectId: "project",
    title: "A task",
  });
  expect(create.status).toBe(200);
  const thread = (await create.json()) as { id: string };
  const queued = await f.post({
    type: "run.queue",
    commandId: "queue",
    threadId: thread.id,
    profileId: "profile",
    prompt: "Do native work",
  });
  expect(queued.status).toBe(200);
  return {
    thread,
    run: (await queued.json()) as { id: string; revision: number },
  };
}
describe("native workbench security and API", () => {
  it("requires a token and rejects cross-origin requests, rebinding hosts and static traversal", async () => {
    const f = await setup();
    try {
      const page = await fetch(f.wb.url + "/");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect((await fetch(f.wb.url + "/api/state")).status).toBe(401);
      expect(
        (
          await fetch(f.wb.url + "/api/state", {
            headers: { ...f.headers, Authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(f.wb.url + "/api/state", {
            headers: { ...f.headers, Origin: "https://attacker.example" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(f.wb.url + "/api/state", {
            headers: { ...f.headers, Origin: "null" },
          })
        ).status,
      ).toBe(403);
      // Fetch normalizes forbidden Host overrides; exercise the actual wire header.
      const rebound = await new Promise<number>((resolve) => {
        const request = rawRequest(
          f.wb.url + "/api/state",
          { headers: { ...f.headers, Host: "attacker.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.end();
      });
      expect(rebound).toBe(403);
      const options = await fetch(f.wb.url + "/api/command", {
        method: "OPTIONS",
        headers: f.headers,
      });
      expect(options.status).toBe(405);
      expect(options.headers.has("access-control-allow-origin")).toBe(false);
      expect(
        (await fetch(f.wb.url + "/src/store.ts", { headers: f.headers }))
          .status,
      ).toBe(404);
      const state = await fetch(f.wb.url + "/api/state", {
        headers: f.headers,
      });
      expect(state.status).toBe(200);
      expect(await state.text()).not.toContain(f.wb.token);
    } finally {
      await f.cleanup();
    }
  });
  it("enforces bounded JSON commands and fixed project/provider scope", async () => {
    const f = await setup();
    const other = await fixture();
    try {
      expect(
        (
          await f.post({
            type: "thread.create",
            commandId: "bad",
            projectId: "unknown",
            title: "bad",
          })
        ).status,
      ).toBe(403);
      const foreign = await f.core.createThread("foreign", {
        repository: other.repo,
        title: "Private other project",
      });
      expect(
        (
          await fetch(f.wb.url + "/api/threads/" + foreign.id, {
            headers: f.headers,
          })
        ).status,
      ).toBe(403);
      const { thread } = await queue(f);
      expect(
        (
          await f.post({
            type: "run.queue",
            commandId: "bad-provider",
            threadId: thread.id,
            profileId: "unknown",
            prompt: "x",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await f.post({
            type: "run.queue",
            commandId: "extra",
            threadId: thread.id,
            profileId: "profile",
            prompt: "x",
            automaticCompletion: true,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await f.post({
            type: "run.queue",
            commandId: "huge",
            threadId: thread.id,
            profileId: "profile",
            prompt: "x".repeat(70000),
          })
        ).status,
      ).toBe(413);
      const malformed = await fetch(f.wb.url + "/api/command", {
        method: "POST",
        headers: f.headers,
        body: "{broken",
      });
      expect(malformed.status).toBe(400);
      const wrongType = await fetch(f.wb.url + "/api/command", {
        method: "POST",
        headers: { ...f.headers, "Content-Type": "text/plain" },
        body: "{}",
      });
      expect(wrongType.status).toBe(415);
      const outOfScope = f.core.queue("unsupported-model", {
        threadId: thread.id,
        driverId: "native",
        model: "not-allowed",
        prompt: "not authorized by profile",
      });
      expect(
        (
          await f.post({
            type: "run.approve",
            commandId: "approve-unsupported",
            runId: outOfScope.id,
            revision: 1,
          })
        ).status,
      ).toBe(403);
      f.core.approve("trusted-internal-approve", outOfScope.id);
      expect(
        (
          await f.post({
            type: "run.execute",
            commandId: "execute-unsupported",
            threadId: thread.id,
          })
        ).status,
      ).toBe(403);
    } finally {
      await f.cleanup();
      await other.cleanup();
    }
  });
  it("binds approval to task revision and replays execution receipts without starting the next run", async () => {
    let calls = 0;
    const f = await setup({
      ...driver,
      async run(turn, emit, signal) {
        calls++;
        await driver.run(turn, emit, signal);
      },
    });
    try {
      const { thread, run } = await queue(f);
      const edit = await f.post({
        type: "run.edit",
        commandId: "edit",
        runId: run.id,
        revision: 1,
        profileId: "profile",
        prompt: "Edited exact task",
      });
      expect(edit.status).toBe(200);
      expect(
        (
          await f.post({
            type: "run.approve",
            commandId: "stale",
            runId: run.id,
            revision: 1,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await f.post({
            type: "run.approve",
            commandId: "approve",
            runId: run.id,
            revision: 2,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.post({
            type: "run.execute",
            commandId: "queue",
            threadId: thread.id,
          })
        ).status,
      ).toBe(409); // command ID already belongs to queue
      const execute = {
        type: "run.execute",
        commandId: "execute",
        threadId: thread.id,
      };
      const accepted = await f.post(execute);
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual({ runId: run.id });
      await vi.waitFor(
        () => expect(f.core.store.run(run.id).status).toBe("completed"),
        { timeout: 8000 },
      );
      const second = f.core.queue("second", {
        threadId: thread.id,
        driverId: "native",
        model: "test",
        prompt: "Second approved task",
      });
      f.core.approve("a2", second.id);
      expect(await (await f.post(execute)).json()).toEqual({ runId: run.id });
      expect(calls).toBe(1);
      expect(f.core.store.run(second.id).status).toBe("queued");
      const events = (await (
        await fetch(
          f.wb.url + "/api/threads/" + thread.id + "/events?after=0",
          { headers: f.headers },
        )
      ).json()) as { events: Array<{ sequence: number }>; nextCursor: number };
      expect(events.events.length).toBeGreaterThan(0);
      const next = (await (
        await fetch(
          f.wb.url +
            `/api/threads/${thread.id}/events?after=${events.nextCursor}`,
          { headers: f.headers },
        )
      ).json()) as { events: unknown[] };
      expect(next.events).toEqual([]);
      const review = await fetch(f.wb.url + `/api/runs/${run.id}/review`, {
        headers: f.headers,
      });
      expect(review.status).toBe(200);
      const fork = await f.post({
        type: "thread.fork",
        commandId: "fork",
        runId: run.id,
        phase: "after",
        title: "Branched",
      });
      expect(fork.status).toBe(200);
    } finally {
      await f.cleanup();
    }
  });
  it("does not take ownership of a replayed execution from another controller", async () => {
    const native: NativeDriver = {
      id: "native",
      contextMode: "portable",
      async run(turn) {
        await turn.request!({
          kind: "approval",
          title: "Other controller task",
          detail: "This executor belongs to another core.",
        });
      },
    };
    const f = await setup(native);
    const owner = new CoderCore(f.state, [native]);
    let execution: Promise<unknown> | undefined;
    let runId = "";
    try {
      const { thread, run } = await queue(f);
      runId = run.id;
      owner.approve("owner-approve", run.id, 1);
      execution = owner.executeNext(thread.id, "owner-execution");
      await vi.waitFor(
        () => expect(owner.store.run(run.id).status).toBe("blocked"),
        { timeout: 8000 },
      );
      const replay = await f.post({
        type: "run.execute",
        commandId: "owner-execution",
        threadId: thread.id,
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual({ runId: run.id });
      await f.wb.close();
      expect(owner.store.run(run.id).status).toBe("blocked");
    } finally {
      if (runId) owner.cancel("owner-cleanup", runId);
      await execution;
      owner.close();
      await f.cleanup();
    }
  });
  it("surfaces runtime questions and stops its active fixture when the workbench closes", async () => {
    const native: NativeDriver = {
      id: "native",
      contextMode: "portable",
      async run(turn) {
        await turn.request!({
          kind: "questions",
          title: "Input gate",
          questions: [
            {
              id: "q",
              header: "Answer",
              question: "Choose",
              options: [{ label: "One", value: "one" }],
              allowCustomAnswer: false,
            },
          ],
        });
      },
    };
    const f = await setup(native);
    try {
      const { thread, run } = await queue(f);
      await f.post({
        type: "run.approve",
        commandId: "approve",
        runId: run.id,
        revision: 1,
      });
      await f.post({
        type: "run.execute",
        commandId: "execute",
        threadId: thread.id,
      });
      await vi.waitFor(
        () => expect(f.core.store.run(run.id).status).toBe("blocked"),
        { timeout: 8000 },
      );
      const detail = (await (
        await fetch(f.wb.url + "/api/threads/" + thread.id, {
          headers: f.headers,
        })
      ).json()) as { requests: Array<{ id: string; digest: string }> };
      expect(detail.requests.length).toBe(1);
      const request = detail.requests[0]!;
      expect(
        (
          await f.post({
            type: "request.respond",
            commandId: "wrong",
            requestId: request.id,
            digest: request.digest,
            response: { kind: "approval", decision: "allow_once" },
          })
        ).status,
      ).toBe(409);
      await f.wb.close();
      expect(f.core.store.run(run.id).status).toBe("cancelled");
    } finally {
      await f.cleanup();
    }
  });
});
