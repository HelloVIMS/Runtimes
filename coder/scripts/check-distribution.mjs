import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
for (const file of [
  "dist/workbench/index.html",
  "dist/workbench/app.js",
  "dist/workbench/style.css",
  "dist/workbenchCli.js",
  "dist/workbenchDemo.js",
  "dist/third-party/T3-LICENSE",
  "dist/third-party/t3-provenance.json",
])
  assert(fs.statSync(path.join(root, file)).isFile(), file);
const app = read("dist/workbench/app.js");
for (const match of app.matchAll(/from\s+['"](\/t3\/[^'"]+)['"]/g)) {
  const file = "dist" + match[1];
  assert(fs.statSync(path.join(root, file)).isFile(), file);
  const source = read(file);
  assert(
    !/from\s+['"](?:node:|@t3tools\/|effect)/.test(source),
    "Browser helper cannot depend on Node or T3 runtime",
  );
}
assert(!app.includes("innerHTML"), "Agent output must not become markup");
assert(
  !/localStorage\.(?:setItem|\w+\s*=)|sessionStorage\.(?:setItem|\w+\s*=)|document\.cookie/.test(
    app,
  ),
  "Browser credentials must remain memory-only",
);
assert.equal(read("dist/third-party/T3-LICENSE"), read("vendor/t3/LICENSE"));
assert(
  !JSON.parse(read("package.json")).dependencies,
  "Package has no runtime npm dependencies",
);
console.log(
  "Distribution files, browser-helper imports, literal-text rendering, and third-party notices verified. This is not a browser rendering test.",
);
