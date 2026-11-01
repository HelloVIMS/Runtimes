# Native coder adoption changes
## Extension: native workbench and recoverable task workflows
- Add four executable T3 copies/extractions and one upstream test file, retaining
  exact original bytes, mapped hashes and MIT notices (17 mapped files total).
- Add durable runtime questions and per-action allow-once/deny requests; integrate
  blocked-state attention, deadlines, cross-controller replies and cancellation.
- Add optimistic queue edits and revision-bound approval; preserve audit versions
  without duplicating obsolete prompts in the current history projection.
- Add non-destructive before/after checkpoint branches with verified refs and frozen,
  attributed parent context, including nested branches.
- Add atomic, idempotent dispatch receipts: replaying an old run command cannot
  accidentally launch a later task. Preserve exact execution ownership at shutdown.
- Add explicit loopback-only workbench API, browser interface, owner-configured native
  provider launcher and offline fixture launcher. No T3 service dependency.
- Add schema v1-to-v2 migration and HTTP security/scope/ownership regression tests.
- Extend the verified Windows suite from 40 to 66 cases. Browser acceptance and
  extension Linux validation remain outstanding; no live provider was invoked.
