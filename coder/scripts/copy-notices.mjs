import fs from "node:fs";
fs.mkdirSync("dist/third-party", { recursive: true });
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
  fs.copyFileSync(name, `dist/${name}`);
fs.copyFileSync("vendor/t3/LICENSE", "dist/third-party/T3-LICENSE");
fs.copyFileSync(
  "vendor/t3/manifest.json",
  "dist/third-party/t3-provenance.json",
);
console.log("Distribution includes original T3 MIT notice and provenance.");
