# Direct native Codex app-server integration
## Why this exists
The previous generic `NativeTurn.request` API could demonstrate approval UX but
`codex exec --json` could not return a human answer to a native server request.
`CodexAppServerDriver` adds a bidirectional stdio transport so supported Codex
requests actually reach the VIMS broker and receive its response. It is not a T3
connector and does not import or launch T3's full adapter/Effect runtime.
The protocol glue is new VIMS code. Two additional T3 implementations are copied:
the pure token-usage accumulator and extracted file-approval/user-answer helpers.
Exact original code, hashes, adaptation notes and MIT notices are retained. See
`vendor/t3/manifest.json` for revision and original paths. The adapter contracts
were checked against the official app-server documentation and TypeScript bindings
generated locally by `codex-cli 0.160.0`; those generated bindings are not bundled.
Primary references:
- [OpenAI app-server documentation](https://developers.openai.com/codex/app-server/)
- [Pinned T3 Codex adapter](https://github.com/pingdotgg/t3code/blob/575579d68ac4bae09f8426a345d4a3eac1e90c67/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)
- [Pinned T3 token accumulator](https://github.com/pingdotgg/t3code/blob/575579d68ac4bae09f8426a345d4a3eac1e90c67/apps/server/src/provider/CodexTurnTokenUsage.ts)
## Configure explicitly
```json
{
  "id": "codex-local",
  "binary": "/absolute/path/to/native/codex",
  "transport": "app-server-stdio",
  "allowWorkspaceWrites": false
}
```
This is one driver entry in the workbench's owner-supplied configuration. Existing
configurations that omit transport keep `exec-jsonl`; an upgrade does not silently
change execution protocol. Use a native executable, not a shell/batch shim.
Workspace writes require explicit owner opt-in. The selected model and project
come from the fixed workbench profile/allowlist, not model-generated arguments.
No model name, account, key, credential lookup or remote endpoint is hardcoded.
## Verified startup and native turn identity
The driver starts exactly `codex app-server --listen stdio://`, negotiates
initialization, sends `initialized`, and only then creates an ephemeral provider
thread. It asks for human review (`on-request`, reviewer `user`), the configured
model/cwd, and a read-only or workspace-write baseline without network access.
The response must confirm the requested model, directory and approval/reviewer
policy; broader sandbox/network/extra-root acknowledgements fail before turn/start.
The turn carries explicit sandbox settings, with workspace writes restricted to
the owned worktree and temporary-root exclusions. Dynamic history is registered
only when the VIMS host supplies the scoped retrieval callback. Each VIMS run
starts a fresh ephemeral native thread and receives portable attributed history.
Native thread and turn IDs are recorded for audit/cancellation, **not** a claim of
resume/fork fidelity. Persistent Codex conversations/resumption are not implemented.
A native completion can arrive before the turn/start acknowledgement; bounded
buffering preserves it until the returned turn ID is known. Other-thread or
other-turn notifications cannot masquerade as the current result. Malformed or
unexpected response IDs, repeated server request IDs, output overflow and lost
acknowledgements fail closed without automatically replaying work.
## Native human requests
| Native request | VIMS handling |
| --- | --- |
| `item/commandExecution/requestApproval` | Full action detail; one-time accept or decline, only with owner workspace-write opt-in |
| `item/fileChange/requestApproval` | Requires the corresponding proposed file-change item; full bounded review, never an abbreviated approval |
| `item/tool/requestUserInput` | Ordinary bounded questions with exact choice/custom strings; secret questions rejected |
| `item/permissions/requestApproval` | Empty permission grant; no expansion of the configured policy |
| `mcpServer/elicitation/request` | Declined; no login/browser flow or persistent approval |
| Unknown/legacy authority-bearing methods | Rejected, not guessed or implicitly approved |
Read-only mode declines approval callbacks rather than treating them as a way to
upgrade read-only operation. Explicit additional permission profiles, network
approval context and session-wide file grant roots are rejected. Available decision
lists must permit a one-time accept; session/rule-policy amendment responses are
never emitted. A user still needs to review command contents: `allow_once` is an
authorization of the exact native action, not independent enforcement of its
semantics. An already allowed native tool may execute within its baseline without
requesting approval. This package does not prove shell command safety or intercept
every tool implementation or inherited provider integration.
The displayed request is content-digest bound and persisted by the existing broker.
Concurrent provider prompts are serialized. Numeric and string RPC IDs remain
distinct. `serverRequest/resolved` aborts the exact pending prompt; late UI answers
cannot produce a provider reply. Cancelling the run aborts its prompts and asks
`turn/interrupt` for that exact native thread/turn before closing the owned process.
Detached subprocesses and external effects still cannot be guaranteed reversed.
A request too large to show completely is rejected rather than silently truncated
and approved. Unknown protocol features fail closed. This conservative first
integration intentionally does not support every Codex/MCP workflow.
## Real history recovery, not instructions for a nonexistent tool
The provider receives a native dynamic function named `vims_thread_read`. It can
retrieve omitted items in its current VIMS task or its frozen checkpoint lineage.
Core enforcement clamps event/ordinal boundaries and excludes unexecuted queued
drafts, current/future runs and unrelated threads, even when the model supplies
larger bounds. Output is paged and bounded. Unsupported scope/oversized output
returns a generic failed tool result; private paths/errors are not returned.
The host's authenticated human transcript can still show queued prompts. Model
retrieval and human UI visibility are separate. No broad filesystem or arbitrary
SQL function is exposed. The function is local stdio, not an installed remote MCP
server and not a second public listener.
## Reported usage and capability disclosure
The copied T3 accumulator distinguishes first responses, repeated cumulative
updates, counter resets, and completed versus interrupted turns. Cache reads/writes
are subcounts of input, and reasoning is a subcount of output. The run stores raw
native totals with `complete`, `partial` or `unavailable`, and the main-agent scope
is explicit. Missing telemetry is not invented as zero usage. Subagent detection
is a caveat, not a claim that child costs are fully counted. No dollars, billing
accuracy, subscription credit balance or cost estimate is fabricated.
The control API reports per-driver capabilities, and UI source displays transport,
native approval support and token totals. `exec-jsonl` honestly reports no native
approval/history/usage bridge. Neither driver claims native resumption. Browser
rendering of these additional labels has not been acceptance-tested.
## Bounded transport and diagnostics
The native transport caps single JSONL frames at 1 MiB, cumulative output at 8 MiB,
stderr at 64 KiB, outstanding client requests at 16 and native request IDs at 256.
Request timeouts and the overall turn deadline are independent. User-facing errors
do not relay provider stderr or arbitrary error payloads. Prompts and responses
travel on stdin/stdout, not command-line flags or shell interpolation. Whole native
process dumps, auth files and environment values are never logged by the adapter.
An explicit offline diagnostic is available after building:
```sh
node scripts/probe-codex.mjs --binary /absolute/path/to/native/codex
```
It initializes the actual executable with a temporary isolated CODEX_HOME and
sensitive environment names omitted. It sends **no thread/start, turn/start or
model/list request**, and does not perform inference. The result is printed only
after process shutdown and temporary-home cleanup. Windows transient file locks are
retried within a bounded cleanup budget. The diagnostic passed against native
Codex CLI 0.160.0 on Windows Node 24.22.1.
## Validation boundaries
The package suite passes 101 cases on Windows, including 29 app-server transport/
protocol cases, five copied-algorithm edge-case tests and the existing core/API
regressions. Protocol cases use actual fixture child processes and the actual VIMS
broker/SQLite where indicated. The real Codex binary was tested only through
initialization, not through a live model turn or real command/file approval event.
Browser acceptance is still blocked/unverified and was not retried through another
route. The latest native protocol increment has not been rerun on Linux. Private
VIMS desktop/permission-center wiring, additional provider protocols, native-session
resumption, unattended remote access and destructive rollback remain outstanding.
No services were installed or left running, no production settings/pairings changed,
and no merge, release or deployment was performed by this contribution.
