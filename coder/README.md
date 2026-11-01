# VIMS native coding core and workbench
This package **copies and adapts T3 Code implementation into VIMS-owned code**.
It is not a T3 connector: no T3 app, executable, daemon, account, service or runtime
package is required. SQLite state, Git worktrees, native-provider execution and the
optional browser workbench belong to this package. Runtime npm dependencies: zero.
**Integration status:** source-adoption candidate, submitted as a draft. The private
VIMS desktop/daemon code is not accessible in this repository, so the released VIMS
Coder UI is not changed. The included workbench is a separate, opt-in local control
surface. Existing eight-shell runtime build/release targets are untouched. Nothing
starts automatically, and no live provider or production deployment was exercised.
## Start with the offline demonstration
Node 22.13+ with `node:sqlite` and Git are required; the extension was tested on
Windows with Node 24.22.1. No model account is needed for these checks or fixtures:
```sh
cd coder
npm ci --ignore-scripts
npm run verify:vendor
npm run typecheck
npm test
npm run build
npm run verify:dist
npm run demo
```
`demo` runs two native fixture providers against disposable Git/SQLite data, passes
portable history between them, and reports a real checkpoint diff. It does not
launch a browser or call a model. All temporary fixture data is removed afterward.
To explicitly launch the offline workbench fixture:
```sh
npm run workbench:demo
```
The launcher prints a private loopback URL with a session token. Open it on the
same computer. The fixture asks a format question, requests one file-write approval,
and writes only its own isolated worktree. The interface labels this as a fixture,
not an AI/model response. Ctrl+C closes its server and removes its disposable data.
Do not share the URL/token. Browser interaction and visual rendering have not yet
been acceptance-tested; the API/core tests below are not a substitute for that.
## Configure direct native-provider execution
Copy `examples/workbench.config.example.json` to a private local config file and
replace every placeholder with owner-selected absolute paths and a model supported
by your installed CLI. Use a **native Codex executable**, not a `.cmd`, `.bat` or
PowerShell shim. Windows JSON paths may use forward slashes, such as `C:/Projects/x`.
```sh
npm run workbench -- --config /absolute/path/to/private-config.json
```
The configuration fixes the allowed projects, provider executables and model
profiles. `allowWorkspaceWrites` defaults to false. Enable it deliberately only
for a trusted native provider and project. No task starts until its exact revision
is approved and a run is dispatched. Model calls may consume your existing quota.
No embedded keys or fixed model names are supplied, and CLI credentials are not
read or copied by this package. Normal provider authentication remains with the CLI.
The direct Codex adapter is contract-tested, not live-provider-tested. It uses
`codex exec --json`, prompt stdin and an explicit `read-only` or `workspace-write`
sandbox. It never sets `danger-full-access` or invokes T3. Other providers implement
`NativeDriver.run(turn, emit, signal)`; their production adapters are not included.
## What is actually copied from T3
Pinned upstream: `pingdotgg/t3code@575579d68ac4bae09f8426a345d4a3eac1e90c67`.
There are **13 implementation copies/extractions and four copied test files**.
| Executable copy | Native use |
| --- | --- |
| `handoffBudget.ts` | Context occupancy and attachment allowance, intact-item selection, serialized UTF-8 budgets, attributed history and omitted-item references |
| `handoff.ts` | Provider/model source and destination identity and handoff preview |
| `QueuedRunOrder.ts` | Completion priority, queue position and stable ordinal ordering |
| `Diffs.ts` | NUL-delimited Git numstat, including renames, Unicode and binary files |
| `worktreeSetup.ts` | Setup-state visibility and failure presentation |
| `liveEvents.ts` | Extracted whole-update coalescing with cursor/barrier preservation |
| `inbox.ts`, `activity.ts`, `timestamps.ts` | Extracted working/attention classification and deterministic sorting |
| `pendingUserInput.ts` | Exact option values, single/multi-choice answers, custom text and intentionally cleared editor answers |
| `pendingUserInputProgress.ts` | Extracted question progress and displaced-draft preservation |
| `queuedRunEdit.ts` | Extracted edit-exit policy and question/edit conflict guard |
| `forkPolicy.ts` | Extracted source-run forkability checks; VIMS approval-waiting is explicitly mapped to non-forkable |
These are actual source copies, not merely similar features. `vendor/t3/manifest.json`
records original paths, Git blob IDs, source/adapted SHA-256s and per-file changes.
The exact originals are retained under `vendor/t3/upstream/` for inspection. They
are an audit archive, not additional executable imports. `verify:vendor` checks all
17 mapped files and the original MIT notice. Build output includes notices too.
The full T3 Effect orchestration/streaming engine and reactive edit store are not
ported. Local structural types replace type-only imports; they are not full T3 wire
schemas. SQLite persistence, request handling, Git operations, native adapters,
HTTP server and browser layout are new composition code unless marked otherwise.
No T3 artwork, product branding or endorsement is used. Preserve the MIT notice and
`THIRD_PARTY_NOTICES.md` in redistributed/bundled derivatives.
## Native workflows
### Queue, edit, approve and execute
Every mutation has a caller-selected command ID and a stored receipt. Identical
retries return the original acknowledgement; conflicting input is rejected.
`dispatchNext` commits admission and the command receipt together. Retrying an old
dispatch cannot accidentally start the next queued task.
`editQueued` requires the revision the human reviewed. It is allowed only before
execution, increments the revision and **revokes previous approval**. `approve`
accepts an expected revision; the workbench always requires it. Edits are blocked
while a runtime question owns the composer. The current transcript projects the
latest item revision, while the append-only audit trail preserves earlier values.
### Runtime questions and request-specific approvals
A participating native adapter can `await turn.request(spec)`. The durable broker
stores the exact question/action content, its digest, deadline, answer and outcome,
then marks the run blocked. A second authorized local controller can answer it.
Question normalization and progress use the copied T3 implementation.
Approval answers are only `allow_once` or `deny`. No blanket full-access response
exists. Answers are tied to the displayed request digest; mismatched, expired,
cancelled or late answers are refused. Requests are bounded to 1ΓÇô8 questions,
16 options each, 32 KiB per request and at most 32 requests per run. The default
response deadline is two minutes, configurable by the adapter up to ten minutes.
The workbench marks blocked questions/approvals as needing human attention.
**This is not automatic interception of every provider tool call.** An adapter must
use the callback and honor its answer before acting. The included Codex `exec`
adapter does not bridge Codex-native interactive approval RPCs. Full tool-level
provider protocol integration remains outstanding. Never expose human approval or
recovery methods as unrestricted model tools.
### Branch from a checkpoint instead of overwriting work
`forkThread` verifies a recorded before/after checkpoint against its owned Git ref,
creates a new thread with that exact base, and uses a new detached worktree when it
runs. The original worktree and primary checkout are not reset, cleaned or merged.
Before-forks exclude the source run's context; after-forks include it. Failed but
checkpointed runs can be inspected and branched too.
Inherited history is frozen by source event sequence and run ordinal. A later
parent message, edit or run cannot silently alter a child's inherited context.
Nested forks retain the same source attribution, with a bounded lineage of 16
ancestors. `vims_thread_read` accepts snapshot bounds for omitted-history recovery.
This is non-destructive checkpoint branching, not full provider-native conversation
forking or destructive rollback. Those remain different integration tasks.
## Workbench controls and security boundary
The optional `startWorkbench` server binds only `127.0.0.1`. It is not a remotely
reachable or multi-tenant service. The launcher-generated token grants owner-level
control over configured projects/profiles; it is not a per-user identity system.
It must not be given to agents, sent in logs to third parties or exposed publicly.
The API requires a bearer token, checks Host and Origin, rejects cross-site access,
uses no cookies/CORS, and limits command size. Static files come from an explicit
allowlist. The UI removes a token-bearing URL fragment and keeps the token only in
memoryΓÇönot browser storage. Model output is inserted as text, not executable HTML.
The response policy disallows external scripts and framing. These controls do not
protect against a compromised local OS account, trusted extension or malicious
owner-configured executable.
The UI supplies thread/queue controls, exact-task approval, questions and one-time
approval forms, activity, checkpoint diff preview, patch download and branching.
Polling resumes by event cursor. A lost acknowledgement preserves the same immutable
command envelope for retry; it must not be replaced with a new ID to bypass ambiguity.
Shutdown requests cancellation only for the exact runs this workbench admitted,
not other controllers' tasks. Locking the browser session is not cancellation.
The local API shares `CoderCore` with the rest of the package. Existing VIMS desktop,
Flow or MCP integration should reuse these methods while enforcing its own identity,
project policy and permission ceilings. It is not necessary to adopt this HTTP
surface to reuse the native core or copied algorithms.
## Persistence and failure behavior
SQLite uses WAL and FULL synchronization. Schema v2 adds request records/indexes
without dropping v1 threads, command receipts or history. A migration test verifies
reopening original-format data. Keep the state directory private, outside every
project and on a reliable local filesystem. Checkpoints use temporary Git indexes
without staging or resetting the primary worktree's index. Git ignores are honored;
tracked secrets remain the trusted repository owner's responsibility.
A receipt acknowledges a command, not task completion. Read the current run state
for the outcome. Running/claimed/blocked jobs are **not automatically replayed after
process failure**. Independently confirm the old executor stopped, inspect its work,
and use the host-only reconciliation operation before submitting new work.
Cancellation targets the captured child process; detached descendants or external
side effects cannot be guaranteed reversed/stopped. Worktrees are change isolation,
not security sandboxes. Git filters and native tools are executable trust boundaries.
## Validation and remaining work
The extended package passes **66 unit/integration cases on Windows Node 24.22.1**,
including 28 cases from four copied T3 test files. These exercise real disposable
Git repositories, SQLite reopening/migration, HTTP control APIs, cross-controller
input/approval/cancellation, stale revisions, dispatch replay, fixed history branches,
output limits and subprocess behavior. Typecheck, source-provenance checks, build
and built-file/browser-import/license checks also pass.
Browser/mobile rendering and the Playwright interaction suite are **not verified**:
the attempted browser execution was blocked before running. A browser smoke harness
is supplied for maintainer acceptance testing; no passing browser result or screenshot
is claimed. The new extension has not been rerun on Linux; the earlier core had
separate Linux validation. Neither local test results nor a build prove upstream CI
passed. No paid/live provider call was made.
A maintainer browser check, after building, is `npm run test:browser` with a supported
Playwright Chromium installation (or an explicitly configured `CHROME_BIN`). It uses
a disposable fixture, exercises lost-acknowledgement retry and produces desktop/mobile
screenshots. It requires the browser sandbox; it does not enable an unsafe fallback.
Private VIMS desktop wiring, permission-center integration, production provider
acceptance, full native-session fidelity, provider-native approval RPCs, remote/mobile
transport and destructive rollback remain outstanding. This draft is not full T3
parity and not a released/deployed VIMS desktop update.
