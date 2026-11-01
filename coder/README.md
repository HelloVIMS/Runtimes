# VIMS native coding core ΓÇö direct T3 source adoption
This is **not a T3 connector**. It copies and adapts T3 Code source into a VIMS-owned
Node/TypeScript package, then composes it with VIMS-local SQLite persistence, owned
Git worktrees/checkpoints and a direct native-provider interface. No T3 executable,
server, account, service, runtime package or private credential store is required.
**Integration status:** runnable, tested source-adoption candidate. The private
VIMS desktop/daemon source is not in this repository, so this package has **not**
been wired into the released VIMS Coder UI. Its placement under Runtimes is a
reviewable contribution candidate, not a claim that the maintainers approved a
new architecture or that VIMS already has all of T3's features. The existing eight
runtime build/release targets are unchanged. Nothing starts automatically.
## What is actually copied
`vendor/t3/manifest.json` pins the exact T3 revision, original paths, Git blob IDs,
upstream SHA-256s, adapted hashes and each change. Exact original source is retained
under `vendor/t3/upstream/`; do not confuse that audit archive with executable code.
| Executable copy | Native use |
| --- | --- |
| `handoffBudget.ts` | Context occupancy/attachment allowance, intact-item selection, serialized UTF-8 budget, attributed history and omitted-item references |
| `handoff.ts` | Provider/model handoff preview and source/destination identity |
| `QueuedRunOrder.ts` | Completion-priority, user queue position and stable ordinal ordering |
| `Diffs.ts` | NUL-delimited Git numstat parsing, including renames, Unicode and binary files |
| `liveEvents.ts` | Extracted whole-update coalescing with cursor/barrier preservation |
| `inbox.ts`, `activity.ts`, `timestamps.ts` | Extracted working/attention classification and deterministic task sorting |
| `worktreeSetup.ts` | Workspace-setup visibility and failure presentation |
Three upstream test files are also copied and run against the local adaptations.
The T3 Effect dependency injection/configuration layer is not pulled in; type-only
imports use a small, explicit local structural contract. These are **not** T3's
complete wire schemas. VIMS storage, process handling and composition are new glue,
not falsely attributed copies of T3's complete orchestration engine.
T3's MIT copyright and permission notice are preserved in `vendor/t3/LICENSE` and
`THIRD_PARTY_NOTICES.md`. `npm run build` puts notices/provenance in `dist/` too.
No T3 artwork, product branding or endorsement is used.
## Run and verify without T3 or a model account
Node 22.13+ with `node:sqlite` and Git are required (Node 24 recommended).
```sh
cd coder
npm ci --ignore-scripts
npm run verify:vendor
npm run typecheck
npm test
npm run build
npm run demo
```
The demo creates a disposable Git repository, runs two **fixture** providers,
passes research context between them, changes only the isolated worktree, prints
the real checkpoint diff, then removes its own temporary files. It uses no model,
network call, T3 installation or real user project. Fixture success is not a live
provider-integration claim. Tests and normal builds do not start agent services.
## Use from the VIMS host
```ts
import { CoderCore, CodexExecDriver } from '@vims/coder-core';
// Native executable chosen by the owner. No T3 CLI or T3 server sits in this path.
const provider = new CodexExecDriver('codex-local', '/absolute/path/to/codex', {
  allowWorkspaceWrites: false, // read-only by default; opt in deliberately
});
const core = new CoderCore('/private/vims-coder-state', [provider]);
const thread = await core.createThread('create-unique-id', {
  repository: '/absolute/trusted/project', title: 'Review this project',
});
const run = core.queue('queue-unique-id', {
  threadId: thread.id, driverId: provider.id, model: 'owner-selected-model',
  prompt: 'Review the implementation and propose improvements. Do not deploy.',
});
// Only after the host authenticates the human and shows the exact task/model:
core.approve('approval-unique-id', run.id);
await core.executeNext(thread.id);
const review = await core.review(run.id);
core.close();
```
There are no forced model names or embedded credentials. The Codex adapter uses
`codex exec --json`, stdin prompts and explicit `read-only`/`workspace-write`
sandbox selection. It never sets `danger-full-access`, invokes a shell, or reads
Codex's token files. It relies on the CLI's normal authentication. The owner is
responsible for model usage/costs and provider configuration. Live Codex execution
has not been run in the contribution tests.
Other VIMS runtimes implement `NativeDriver.run(turn, emit, signal)` directly.
They receive a VIMS worktree, prompt and bounded portable historyΓÇönot a T3 thread
ID. The included Codex adapter is original glue, not copied from T3's app-server
adapter. Claude, Hermes, Grok, ACP and native session-resume adapters are **not**
claimed as completed here.
## Host integration contract
The desktop UI, Flow jobs and MCP handlers should call the same `CoderCore` methods.
The package intentionally does not open an HTTP listener, consume pairing tokens,
modify desktop settings or bypass VIMS's own authentication/approval machinery.
- `createThread`, `queue`, `approve`, `reorder`, `cancel`: command-ID checked writes.
- `executeNext`: atomic admission, own worktree, before/after checkpoints, native
  provider execution and persisted outcome; one admitted run per thread.
- `review`: immutable checkpoint diff; it does not merge, reset or deploy.
- `inbox`, `workspaceProgress`, `handoffPreview`: native presentation data.
- `vims_thread_read`: bounded item/cursor/text-offset retrieval for omitted history.
- `liveBatch`: copied T3 coalescing; durable events remain intact in SQLite.
- `reconcileInterrupted`: an explicit recovery action after the host confirms an
  old executor stopped. The library never silently redelivers an ambiguous run.
A host that advertises `vims_thread_read` to a provider must actually expose that
API through its tool system. The standalone Codex adapter does **not** install an
MCP server and explicitly tells Codex to ask the host for omitted history instead.
Approval is task-level in this prototype; per-tool provider approval routing is
not implemented. Never expose `approve` or recovery controls as unrestricted
agent tools. The host must enforce user identity, project access and permission
ceilings before calling any write method. Command IDs prevent accidental replay;
they are not authorization credentials.
## Persistence, cancellation and Git boundaries
Command receipts and state/event changes commit in one SQLite transaction with
WAL and FULL synchronization. Pending approvals cannot execute. Duplicate command
IDs with the same input return the original receipt; different input is rejected.
The receipt is an acknowledgement, not a live status snapshot; read the run record
for its current state. State survives reopening. Running/claimed jobs remain
unresolved after process failure and are **not automatically retried**.
This is not exactly-once distributed execution. A process can fail after a native
agent changed files. Inspect the worktree and old process before reconciling and
submitting a new command. Cancellation targets only the exact spawned child; it
cannot guarantee termination of detached descendants or reverse external effects.
A cancelled run therefore still needs review. Raw provider stderr is not exposed.
Each thread owns a separate, detached Git worktree. Checkpoints use temporary Git
indexes, so the owner's primary index is not staged or reset. The snapshot honors
Git ignores; tracked sensitive files are still part of the trusted repository.
No auto-merge or destructive rollback is supplied. Low-level cleanup requires
explicit confirmation and refuses dirty worktrees. Worktrees are change isolation,
**not security sandboxes**. Git filters, repository instructions and model tools
are executable trust boundaries; use trusted repositories and provider sandboxes.
Keep the state directory outside all projects, private to the host OS account,
and on a reliable local filesystem. The package is a trusted local library, not a
multi-tenant server. Do not pass arbitrary untrusted driver objects or executable
configuration to it. Any remote surface needs VIMS authentication and scoped tools.
## Outstanding integration work
Private VIMS host wiring, the existing desktop review UI, real provider acceptance
tests, permission-center integration, tool-level approvals, native session fidelity,
remote/mobile supervision and safe file rollback remain host integration work.
This package does not claim to replace T3's entire application. It provides copied
T3 functionality that VIMS can own and extend without making T3 a prerequisite.
Codex CLI contract reference: https://developers.openai.com/codex/noninteractive/
