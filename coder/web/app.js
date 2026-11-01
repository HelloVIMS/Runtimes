import {
  derivePendingUserInputProgress,
  carryDisplacedCustomAnswerIntoPrompt,
} from "/t3/pendingUserInputProgress.js";
import {
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
} from "/t3/pendingUserInput.js";
import { resolveQueuedEditExit } from "/t3/queuedRunEdit.js";
const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
};
const button = (label, action, className = "quiet") => {
  const e = node("button", label, className);
  e.type = "button";
  e.addEventListener("click", () => void action());
  return e;
};
let token = "",
  state = null,
  selected = null,
  detail = null,
  epoch = 0,
  refreshing = false,
  edit = null,
  reviewRun = null,
  uncertain = null;
let runSignature = "",
  requestSignature = "",
  threadSignature = "";
const drafts = new Map(),
  answerDrafts = new Map(),
  events = new Map(),
  cursors = new Map();
function notice(message, error = false) {
  $("notice").hidden = !message;
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}
function updatePromptCount() {
  $("prompt-count").textContent =
    `${$("prompt").value.length.toLocaleString()} characters`;
}
async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: "Bearer " + token, ...init.headers },
    cache: "no-store",
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("Uncertain response: the server did not return valid JSON");
  }
  if (!response.ok) {
    const error = new Error(
      value.error ?? `Request failed (${response.status})`,
    );
    error.definitive = response.status >= 400 && response.status < 500;
    error.status = response.status;
    throw error;
  }
  return value;
}
async function submitPending() {
  if (!uncertain || uncertain.sending) return;
  const current = uncertain;
  current.sending = true;
  $("retry").disabled = true;
  try {
    const result = await api("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current.command),
    });
    if (uncertain !== current) return;
    uncertain = null;
    $("uncertain").hidden = true;
    await current.success(result);
    await refresh();
  } catch (error) {
    if (error.definitive) {
      uncertain = null;
      $("uncertain").hidden = true;
    } else {
      $("uncertain").hidden = false;
    }
    notice(error.message, true);
  } finally {
    if (uncertain === current) current.sending = false;
    $("retry").disabled = false;
  }
}
async function command(payload, success = () => {}) {
  if (uncertain) {
    notice("Resolve the outstanding command before submitting another.", true);
    return;
  }
  uncertain = {
    command: {
      ...structuredClone(payload),
      commandId: "web-" + crypto.randomUUID(),
    },
    success,
    sending: false,
  };
  await submitPending();
}
function openThreadDialog() {
  if (!state) return;
  $("thread-dialog").showModal();
  $("new-title").focus();
}
function exitEdit() {
  if (!edit) return;
  const changed = $("prompt").value !== edit.original;
  const decision = resolveQueuedEditExit({
    editChanged: changed,
    threadDraftEmpty: !edit.savedDraft.trim(),
  });
  if (decision === "kept") drafts.set(edit.threadId, $("prompt").value);
  else {
    drafts.set(edit.threadId, edit.savedDraft);
    if (decision === "discarded") {
      $("recovered").hidden = false;
      $("recovered-text").textContent = $("prompt").value;
      notice(
        "The task left the queue. Your existing draft is preserved; the unsaved edit is shown below.",
      );
    }
  }
  edit = null;
  $("composer-title").textContent = "Queue a task";
  $("queue").textContent = "Queue for approval";
  $("cancel-edit").hidden = true;
  $("edit-warning").hidden = true;
  $("prompt").value = drafts.get(selected) ?? "";
  updatePromptCount();
}
function chooseThread(id) {
  if (edit) exitEdit();
  else if (selected) drafts.set(selected, $("prompt").value);
  selected = id;
  epoch++;
  detail = null;
  runSignature = "";
  requestSignature = "";
  $("review").hidden = true;
  reviewRun = null;
  $("prompt").value = drafts.get(id) ?? "";
  updatePromptCount();
  $("empty").hidden = !!id;
  $("thread-workspace").hidden = !id;
  renderThreads();
  void refresh();
}
function renderThreads() {
  if (!state) return;
  const signature = JSON.stringify([state.threads, state.inbox, selected]);
  if (signature === threadSignature) return;
  threadSignature = signature;
  const list = $("threads");
  list.replaceChildren();
  const order = [...state.inbox.working, ...state.inbox.attention];
  for (const id of order) {
    const thread = state.threads.find((t) => t.id === id);
    if (!thread) continue;
    const b = button("", () => chooseThread(thread.id), "thread-link");
    b.setAttribute("aria-current", String(thread.id === selected));
    b.append(
      node("span", thread.title, "title"),
      node(
        "span",
        (state.inbox.working.includes(id) ? "Working" : "Needs review") +
          " ┬╖ " +
          (state.projects.find((p) => p.id === thread.projectId)?.name ?? ""),
        "meta",
      ),
    );
    list.append(b);
  }
  if (!list.children.length) list.append(node("p", "No threads yet.", "fine"));
}
function beginEdit(run) {
  if (edit) exitEdit();
  edit = {
    runId: run.id,
    revision: run.revision ?? 1,
    threadId: selected,
    original: run.prompt,
    savedDraft: $("prompt").value,
  };
  $("prompt").value = run.prompt;
  const profile = state.profiles.find(
    (p) =>
      p.driverId === run.providerInstanceId &&
      p.model === run.modelSelection.model,
  );
  if (profile) $("profile").value = profile.id;
  $("composer-title").textContent = "Edit queued task";
  $("queue").textContent = "Save edit";
  $("cancel-edit").hidden = false;
  $("edit-warning").hidden = false;
  $("prompt").focus();
  updatePromptCount();
}
function renderRuns() {
  if (!detail) return;
  if (edit) {
    const current = detail.runs.find((r) => r.id === edit.runId);
    if (
      !current ||
      !["waiting", "queued"].includes(current.status) ||
      current.revision !== edit.revision
    )
      exitEdit();
  }
  const signature = JSON.stringify(detail.runs);
  if (signature === runSignature) return;
  runSignature = signature;
  const list = $("runs");
  list.replaceChildren();
  $("run-count").textContent = `${detail.runs.length} runs`;
  const pending = detail.runs
    .filter((r) => ["waiting", "queued"].includes(r.status))
    .sort((a, b) => a.queuePosition - b.queuePosition || a.ordinal - b.ordinal);
  const ordered = [
    ...pending,
    ...detail.runs.filter((r) => !pending.includes(r)).reverse(),
  ];
  $("execute").disabled =
    !pending.some((r) => r.status === "queued") ||
    detail.runs.some((r) =>
      ["preparing", "running", "blocked", "cancel_requested"].includes(
        r.status,
      ),
    );
  for (const run of ordered) {
    const card = node("article", undefined, "run-card");
    card.dataset.runId = run.id;
    const top = node("div", undefined, "run-top");
    top.append(
      node("strong", `Run ${run.ordinal}`),
      node("span", run.status.replaceAll("_", " "), "tag " + run.status),
    );
    card.append(
      top,
      node(
        "p",
        `${run.providerInstanceId} / ${run.modelSelection.model} ┬╖ revision ${run.revision ?? 1}`,
        "fine",
      ),
      node("pre", run.prompt, "run-prompt"),
    );
    const capability = state.capabilities?.find(
      (value) => value.driverId === run.providerInstanceId,
    );
    if (capability)
      card.append(
        node(
          "p",
          `${capability.transport} ┬╖ ${capability.runtimeApprovals ? "native approval requests" : "no native approval bridge"} ┬╖ ${capability.nativeResume ? "native resume" : "portable context"}`,
          "fine",
        ),
      );
    if (run.usage?.usageStatus && run.usage.usageStatus !== "unavailable")
      card.append(
        node(
          "p",
          `${run.usage.usageStatus} usage ┬╖ ${(run.usage.inputTokens ?? 0).toLocaleString()} input / ${(run.usage.outputTokens ?? 0).toLocaleString()} output tokens ┬╖ main agent only`,
          "fine",
        ),
      );
    if (run.error) card.append(node("p", run.error, "fine danger"));
    const actions = node("div", undefined, "run-actions");
    if (run.status === "waiting")
      actions.append(
        button(
          "Approve task",
          () =>
            command(
              {
                type: "run.approve",
                runId: run.id,
                revision: run.revision ?? 1,
              },
              () => notice("Exact task revision approved. Run it when ready."),
            ),
          "",
        ),
      );
    if (["waiting", "queued"].includes(run.status)) {
      const editButton = button("Edit", () => beginEdit(run));
      editButton.disabled = detail.requests.length > 0;
      actions.append(editButton);
      const index = pending.indexOf(run);
      for (const [label, delta] of [
        ["Move up", -1],
        ["Move down", 1],
      ]) {
        const b = button(label, () => {
          const ids = pending.map((r) => r.id);
          [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
          return command({
            type: "queue.reorder",
            threadId: selected,
            runIds: ids,
          });
        });
        b.disabled = index + delta < 0 || index + delta >= pending.length;
        actions.append(b);
      }
    }
    if (
      [
        "waiting",
        "queued",
        "preparing",
        "running",
        "blocked",
        "cancel_requested",
      ].includes(run.status)
    )
      actions.append(
        button(
          "Cancel",
          () =>
            command({ type: "run.cancel", runId: run.id }, () =>
              notice(
                "Cancellation requested. Already-performed effects still require review.",
              ),
            ),
          "quiet danger",
        ),
      );
    if (run.before && run.after)
      actions.append(button("Review changes", () => showReview(run.id)));
    if (
      run.startedAt &&
      ["completed", "failed", "cancelled", "interrupted"].includes(run.status)
    )
      for (const phase of ["before", "after"])
        if (run[phase])
          actions.append(
            button(`Branch from ${phase}`, () =>
              command(
                {
                  type: "thread.fork",
                  runId: run.id,
                  phase,
                  title: `${detail.thread.title} ┬╖ ${phase} run ${run.ordinal}`,
                },
                (child) => {
                  notice(
                    "Created a checkpoint branch. The original worktree is unchanged.",
                  );
                  chooseThread(child.id);
                },
              ),
            ),
          );
    card.append(actions);
    list.append(card);
  }
  if (!ordered.length)
    list.append(
      node(
        "p",
        "Queued tasks appear here. No agent starts before approval.",
        "fine",
      ),
    );
}
function renderRequests() {
  const requests = detail?.requests ?? [];
  const signature = JSON.stringify(requests.map((r) => [r.id, r.digest]));
  if (signature === requestSignature) return;
  requestSignature = signature;
  $("requests").replaceChildren();
  for (const request of requests) {
    const section = node("section", undefined, "panel request-card");
    section.dataset.requestId = request.id;
    const head = node("div", undefined, "section-head");
    head.append(
      node("h2", request.spec.title),
      node(
        "span",
        request.spec.kind === "approval" ? "Approval needed" : "Answer needed",
        "tag warning",
      ),
    );
    section.append(head);
    if (request.spec.kind === "approval") {
      section.append(node("pre", request.spec.detail, "run-prompt"));
      const actions = node("div", undefined, "run-actions");
      for (const [label, decision] of [
        ["Allow once", "allow_once"],
        ["Deny", "deny"],
      ])
        actions.append(
          button(
            label,
            () =>
              command(
                {
                  type: "request.respond",
                  requestId: request.id,
                  digest: request.digest,
                  response: { kind: "approval", decision },
                },
                () => notice("Response recorded for this request only."),
              ),
            decision === "allow_once" ? "" : "quiet danger",
          ),
        );
      section.append(actions);
    } else {
      let answers = answerDrafts.get(request.id);
      if (!answers) {
        answers = {};
        for (const q of request.spec.questions)
          if (q.initialAnswer !== undefined)
            answers[q.id] = { customAnswer: q.initialAnswer };
        answerDrafts.set(request.id, answers);
      }
      const form = node("form");
      const progress = node("span", "", "fine");
      const submit = node("button", "Send answers");
      submit.type = "submit";
      const updateProgress = () => {
        const value = derivePendingUserInputProgress(
          request.spec.questions,
          answers,
          0,
        );
        progress.textContent = `${value.answeredQuestionCount} / ${request.spec.questions.length} answered`;
        submit.disabled = !value.isComplete;
      };
      for (const q of request.spec.questions) {
        const field = node("fieldset");
        field.append(node("legend", q.header), node("p", q.question));
        let custom;
        const checks = [];
        const refreshChecks = () => {
          for (const [input, value] of checks)
            input.checked = (
              answers[q.id]?.selectedOptionValues ?? []
            ).includes(value);
          if (custom) custom.value = answers[q.id]?.customAnswer ?? "";
          updateProgress();
        };
        for (const option of q.options) {
          const label = node("label", undefined, "option");
          const input = node("input");
          input.type = q.multiSelect ? "checkbox" : "radio";
          input.name = `${request.id}-${q.id}`;
          const value = option.value ?? option.label.trim();
          input.value = value;
          input.checked = (answers[q.id]?.selectedOptionValues ?? []).includes(
            value,
          );
          input.addEventListener("change", () => {
            const displaced = answers[q.id]?.customAnswer;
            if (displaced?.trim()) {
              $("prompt").value = carryDisplacedCustomAnswerIntoPrompt(
                $("prompt").value,
                displaced,
              );
              updatePromptCount();
              notice("Your typed answer was preserved in the task composer.");
            }
            answers[q.id] = togglePendingUserInputOptionSelection(
              q,
              answers[q.id],
              value,
            );
            refreshChecks();
          });
          checks.push([input, value]);
          const labelText = node("span", option.label);
          if (option.description)
            labelText.append(
              node("span", " ΓÇö " + option.description, "fine"),
            );
          label.append(input, labelText);
          field.append(label);
        }
        if (q.allowCustomAnswer !== false) {
          const label = node("label", "Your answer");
          custom = node("textarea");
          custom.rows = 2;
          custom.setAttribute("aria-label", q.header + " answer");
          custom.value = answers[q.id]?.customAnswer ?? "";
          custom.addEventListener("input", () => {
            answers[q.id] = setPendingUserInputCustomAnswer(
              q,
              answers[q.id],
              custom.value,
            );
            for (const [input, value] of checks)
              input.checked = (
                answers[q.id]?.selectedOptionValues ?? []
              ).includes(value);
            updateProgress();
          });
          field.append(label, custom);
        }
        form.append(field);
      }
      const actions = node("div", undefined, "request-actions");
      actions.append(progress, submit);
      form.append(actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void command(
          {
            type: "request.respond",
            requestId: request.id,
            digest: request.digest,
            response: { kind: "questions", drafts: answers },
          },
          () => notice("Answers recorded. The native task can continue."),
        );
      });
      updateProgress();
      section.append(form);
    }
    $("requests").append(section);
  }
}
function renderActivity() {
  const list = events.get(selected) ?? new Map();
  const element = $("activity");
  element.replaceChildren();
  for (const event of [...list.values()].slice(-200)) {
    const row = node("div", undefined, "event");
    row.append(
      node(
        "span",
        event.kind === "item"
          ? event.item.type.replaceAll("_", " ")
          : event.kind,
        "kind",
      ),
      node("pre", event.kind === "item" ? event.item.text : event.summary),
    );
    element.append(row);
  }
  if (!element.children.length)
    element.append(
      node("p", "Task events and agent output appear here.", "fine"),
    );
}
async function showReview(runId) {
  try {
    const value = await api(`/api/runs/${encodeURIComponent(runId)}/review`);
    reviewRun = runId;
    $("review").hidden = false;
    $("review-title").textContent =
      "Changes in run " +
      (detail?.runs.find((r) => r.id === runId)?.ordinal ?? "");
    $("review-files").replaceChildren();
    for (const file of value.files)
      $("review-files").append(
        node(
          "span",
          `${file.path}  +${file.additions ?? file.added ?? 0} ΓêÆ${file.deletions ?? file.removed ?? 0}`,
          "file-entry",
        ),
      );
    if (!value.files.length)
      $("review-files").append(
        node("span", "No captured file changes.", "fine"),
      );
    $("patch").replaceChildren();
    for (const line of value.patch.split("\n"))
      $("patch").append(
        node(
          "span",
          line || " ",
          "patch-line " +
            (line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "remove"
                : line.startsWith("@@")
                  ? "context"
                  : ""),
        ),
      );
    if (value.patchTruncated)
      notice(
        "Patch preview is truncated. Download the full patch for the complete bounded result.",
      );
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    notice(error.message, true);
  }
}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  const currentEpoch = epoch;
  try {
    state = await api("/api/state");
    $("fixture-banner").hidden = !state.fixtureMode;
    $("connection").textContent = "Local session ┬╖ connected";
    for (const [id, values] of [
      ["profile", state.profiles],
      ["new-project", state.projects],
    ]) {
      const select = $(id);
      const previous = select.value;
      const signature = JSON.stringify(values);
      if (select.dataset.signature !== signature) {
        select.replaceChildren(
          ...values.map((value) => {
            const option = node("option", value.name);
            option.value = value.id;
            return option;
          }),
        );
        select.dataset.signature = signature;
        if ([...select.options].some((o) => o.value === previous))
          select.value = previous;
      }
    }
    renderThreads();
    if (!selected && state.threads.length)
      chooseThread(state.threads.at(-1).id);
    if (selected) {
      const id = selected;
      const value = await api(`/api/threads/${encodeURIComponent(id)}`);
      if (id !== selected || currentEpoch !== epoch) return;
      detail = value;
      $("thread-title").textContent = detail.thread.title;
      $("project-name").textContent =
        state.projects.find(
          (p) => p.id === state.threads.find((t) => t.id === id)?.projectId,
        )?.name ?? "Allowed project";
      $("lineage").textContent = detail.thread.forkedFrom
        ? `Checkpoint branch ┬╖ ${detail.thread.forkedFrom.phase} parent run ┬╖ original worktree unchanged`
        : "Independent task thread ┬╖ changes isolated from the primary checkout";
      renderRequests();
      renderRuns();
      const page = await api(
        `/api/threads/${encodeURIComponent(id)}/events?after=${cursors.get(id) ?? 0}`,
      );
      if (id !== selected || currentEpoch !== epoch) return;
      const list = events.get(id) ?? new Map();
      for (const event of page.events)
        list.set(
          event.kind === "item"
            ? "item:" + event.item.id
            : "event:" + event.sequence,
          event,
        );
      while (list.size > 200) list.delete(list.keys().next().value);
      events.set(id, list);
      cursors.set(id, page.nextCursor);
      renderActivity();
    }
  } catch (error) {
    $("connection").textContent = "Local session ┬╖ connection issue";
    notice(error.message, true);
  } finally {
    refreshing = false;
  }
}
async function unlock(value) {
  token = value.trim();
  try {
    state = await api("/api/state");
    $("login").hidden = true;
    $("app").hidden = false;
    $("sign-out").hidden = false;
    $("token").value = "";
    notice("");
    await refresh();
  } catch (error) {
    token = "";
    notice(error.message, true);
  }
}
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void unlock($("token").value);
});
$("new-thread").addEventListener("click", openThreadDialog);
$("empty-new").addEventListener("click", openThreadDialog);
$("close-thread").addEventListener("click", () => $("thread-dialog").close());
$("thread-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void command(
    {
      type: "thread.create",
      projectId: $("new-project").value,
      title: $("new-title").value,
    },
    (thread) => {
      $("thread-dialog").close();
      $("new-title").value = "";
      chooseThread(thread.id);
      notice("Thread created. Queue a task to begin.");
    },
  );
});
$("prompt").addEventListener("input", updatePromptCount);
$("queue").addEventListener("click", () => {
  if (!selected || !$("prompt").value.trim()) return;
  const prompt = $("prompt").value;
  const profileId = $("profile").value;
  if (edit) {
    const current = edit;
    void command(
      {
        type: "run.edit",
        runId: current.runId,
        revision: current.revision,
        profileId,
        prompt,
      },
      () => {
        if (edit === current && selected === current.threadId) {
          const saved =
            $("prompt").value === prompt
              ? current.savedDraft
              : $("prompt").value;
          edit = null;
          $("prompt").value = saved;
          drafts.set(current.threadId, saved);
          $("composer-title").textContent = "Queue a task";
          $("queue").textContent = "Queue for approval";
          $("cancel-edit").hidden = true;
          $("edit-warning").hidden = true;
          updatePromptCount();
        }
        notice("Task edited. Previous approval was revoked.");
      },
    );
  } else {
    const threadId = selected;
    void command({ type: "run.queue", threadId, profileId, prompt }, () => {
      if (selected === threadId && !edit && $("prompt").value === prompt) {
        $("prompt").value = "";
        drafts.set(threadId, "");
        updatePromptCount();
      } else if (drafts.get(threadId) === prompt) drafts.set(threadId, "");
      notice(
        "Task queued. Review its exact prompt and provider before approving.",
      );
    });
  }
});
$("cancel-edit").addEventListener("click", () => {
  if (!edit) return;
  const saved = edit.savedDraft;
  edit = null;
  $("prompt").value = saved;
  $("composer-title").textContent = "Queue a task";
  $("queue").textContent = "Queue for approval";
  $("cancel-edit").hidden = true;
  $("edit-warning").hidden = true;
  updatePromptCount();
});
$("execute").addEventListener("click", () => {
  if (selected)
    void command({ type: "run.execute", threadId: selected }, (result) =>
      notice(
        result.runId
          ? "Native task admitted. Supervision continues here."
          : "No runnable approved task is available.",
      ),
    );
});
$("retry").addEventListener("click", () => void submitPending());
$("download-patch").addEventListener("click", async () => {
  if (!reviewRun) return;
  try {
    const response = await fetch(
      `/api/runs/${encodeURIComponent(reviewRun)}/patch`,
      { headers: { Authorization: "Bearer " + token } },
    );
    if (!response.ok) throw new Error("Patch download failed");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = node("a");
    a.href = url;
    a.download = `vims-${reviewRun}.patch`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    notice(error.message, true);
  }
});
$("sign-out").addEventListener("click", () => {
  if (
    uncertain &&
    !confirm(
      "An unresolved command may already have run. Locking does not cancel it. Continue?",
    )
  )
    return;
  token = "";
  uncertain = null;
  state = null;
  selected = null;
  detail = null;
  edit = null;
  events.clear();
  cursors.clear();
  answerDrafts.clear();
  drafts.clear();
  epoch++;
  $("app").hidden = true;
  $("login").hidden = false;
  $("sign-out").hidden = true;
  $("uncertain").hidden = true;
  $("connection").textContent = "Local session ┬╖ locked";
  notice("Locked. Running tasks were not cancelled.");
});
const fragment = location.hash.slice(1);
if (fragment) {
  history.replaceState(null, "", location.pathname);
  void unlock(decodeURIComponent(fragment));
}
setInterval(() => void refresh(), 800);
