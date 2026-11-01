# Native coder core
This is a source transplant, NOT a connector to T3. Do not introduce a T3 executable,
server, account, runtime package or hosted service dependency. Preserve the MIT
notice and provenance records. Changed adapted files need manifest hash updates and
an explanation; do not silently rewrite exact upstream snapshots. Run npm run
verify:vendor, npm run typecheck, npm test, npm run build. All execution tests use
fixture adapters and disposable repositories; no paid model calls or live user
projects. Do not change the existing runtime release matrix for this prototype.
