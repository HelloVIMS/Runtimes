#!/usr/bin/env node
// Packages a built moltworker tree (after `npm run build`) into the bundle VIMS
// deploys through the Cloudflare API, without wrangler or Docker:
//
//   <out>/manifest.json   what to upload: modules, bindings, container, assets
//   <out>/worker/...      the worker's ES modules and text modules
//   <out>/assets/...      the static assets (admin UI)
//
// Asset hashes match wrangler's (blake3 of base64(content) + extension, first
// 32 hex chars), so the assets-upload-session dedupes against prior uploads.
//
// Usage: node moltworker-bundle.mjs <moltworker-dir> <out-dir> <version> <image-ref>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [srcDir, outDir, version, image] = process.argv.slice(2);
if (!srcDir || !outDir || !version || !image) {
  console.error("usage: moltworker-bundle.mjs <moltworker-dir> <out-dir> <version> <image-ref>");
  process.exit(2);
}
if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
  console.error(`image must be digest-pinned (…@sha256:<64 hex>), got ${image}`);
  process.exit(2);
}
const require = createRequire(path.join(path.resolve(srcDir), "package.json"));
const blake3 = require("blake3-wasm");

const workerDir = path.join(srcDir, "dist", "moltbot_sandbox");
const wrangler = JSON.parse(fs.readFileSync(path.join(workerDir, "wrangler.json"), "utf8"));
const assetsDir = path.resolve(workerDir, wrangler.assets.directory);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join("/"))
    .sort();

// Modules: every .js / .mjs is an ES module; .html / .txt are text modules
// (wrangler's default rules). Source maps and build metadata are not uploaded.
const moduleType = (name) => {
  if (/\.m?js$/.test(name)) return "application/javascript+module";
  if (/\.(html|txt|sql)$/.test(name)) return "text/plain";
  return null;
};
const modules = walk(workerDir)
  .filter((f) => !f.startsWith(".vite/") && f !== "wrangler.json")
  .map((name) => ({ name, type: moduleType(name) }))
  .filter((m) => m.type !== null);
if (!modules.some((m) => m.name === wrangler.main)) {
  console.error(`main module ${wrangler.main} missing from ${workerDir}`);
  process.exit(1);
}

const ignore = new Set([".assetsignore"]);
const ignoreFile = path.join(assetsDir, ".assetsignore");
if (fs.existsSync(ignoreFile)) {
  for (const line of fs.readFileSync(ignoreFile, "utf8").split(/\r?\n/)) {
    if (line.trim() && !line.startsWith("#")) ignore.add(line.trim());
  }
}
const assets = {};
for (const rel of walk(assetsDir)) {
  if (ignore.has(rel) || ignore.has(path.basename(rel))) continue;
  const buf = fs.readFileSync(path.join(assetsDir, rel));
  const ext = path.extname(rel).slice(1);
  assets["/" + rel] = {
    hash: blake3.hash(buf.toString("base64") + ext).toString("hex").slice(0, 32),
    size: buf.length,
  };
}

const [container] = wrangler.containers ?? [];
const [doBinding] = wrangler.durable_objects?.bindings ?? [];
const [r2] = wrangler.r2_buckets ?? [];
if (!container || container.scheduling_policy !== "durable_object" || !doBinding || !r2) {
  console.error("wrangler.json lacks the durable_object container, its Durable Object binding or the R2 bucket");
  process.exit(1);
}
const exportEntry = wrangler.exports?.[container.class_name];
const imageName = Object.keys(container.images ?? {})[0];
if (!exportEntry || !imageName) {
  console.error("wrangler.json lacks exports.<class>.container or a named image");
  process.exit(1);
}

const manifest = {
  schema: 1,
  version,
  image,
  script: {
    main_module: wrangler.main,
    compatibility_date: wrangler.compatibility_date,
    compatibility_flags: wrangler.compatibility_flags ?? [],
    modules,
    crons: wrangler.triggers?.crons ?? [],
    observability: wrangler.observability ?? { enabled: true },
  },
  durable_object: { binding: doBinding.name, class_name: doBinding.class_name, storage: exportEntry.storage },
  container: { class_name: container.class_name, image_name: imageName },
  r2: { binding: r2.binding, bucket: r2.bucket_name },
  browser_binding: wrangler.browser?.binding ?? null,
  assets_binding: {
    binding: wrangler.assets.binding,
    config: {
      html_handling: wrangler.assets.html_handling,
      not_found_handling: wrangler.assets.not_found_handling,
      run_worker_first: wrangler.assets.run_worker_first,
    },
  },
  assets,
};

fs.rmSync(outDir, { recursive: true, force: true });
for (const m of modules) {
  const dst = path.join(outDir, "worker", m.name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(workerDir, m.name), dst);
}
for (const rel of Object.keys(assets)) {
  const dst = path.join(outDir, "assets", rel.slice(1));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(assetsDir, rel.slice(1)), dst);
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`bundle ${version}: ${modules.length} modules, ${Object.keys(assets).length} assets, image ${image}`);
