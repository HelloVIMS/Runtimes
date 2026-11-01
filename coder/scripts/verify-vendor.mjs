import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "vendor/t3/manifest.json"), "utf8"),
);
const license = fs.readFileSync(path.join(root, "vendor/t3/LICENSE"));
if (
  createHash("sha256").update(license).digest("hex") !==
    manifest.licenseSha256 ||
  !license.equals(
    fs.readFileSync(path.join(root, "vendor/t3/upstream/LICENSE")),
  )
)
  throw new Error("T3 MIT notice mismatch");
for (const file of manifest.files) {
  const raw = fs.readFileSync(
    path.join(root, "vendor/t3/upstream", file.upstream),
  );
  const sha = createHash("sha256").update(raw).digest("hex");
  const blob = createHash("sha1")
    .update(`blob ${raw.length}\0`)
    .update(raw)
    .digest("hex");
  const adapted = fs.readFileSync(path.join(root, file.destination));
  if (
    sha !== file.sourceSha256 ||
    blob !== file.gitBlob ||
    createHash("sha256").update(adapted).digest("hex") !== file.adaptedSha256
  )
    throw new Error(`provenance mismatch: ${file.destination}`);
  if (!adapted.toString().includes("Copyright (c) 2026 T3 Tools Inc."))
    throw new Error("missing attribution");
}
console.log(
  `Verified ${manifest.files.length} copied/adapted files against ${manifest.commit}`,
);
