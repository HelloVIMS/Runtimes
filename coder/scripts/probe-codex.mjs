// Explicit offline protocol handshake. Never calls thread/start, turn/start or model/list.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RpcChild } from "../dist/rpcChild.js";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--binary" || !path.isAbsolute(args[1]))
  throw new Error(
    "Usage: node scripts/probe-codex.mjs --binary /absolute/path/to/native/codex",
  );
const binary = args[1];
if (/\.(cmd|bat|ps1)$/i.test(binary))
  throw new Error("Native executable required");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "vims-offline-probe-"));
let rpc;
let report;
try {
  const home = path.join(root, "codex-home");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.writeFile(
    path.join(home, "config.toml"),
    "[analytics]\nenabled = false\n[feedback]\nenabled = false\n",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/OPENAI|AZURE|TOKEN|API_KEY|SECRET|CREDENTIAL/i.test(key),
    ),
  );
  env.CODEX_HOME = home;
  const version = (
    await promisify(execFile)(binary, ["--version"], {
      cwd: root,
      env,
      timeout: 5000,
      maxBuffer: 8192,
      windowsHide: true,
    })
  ).stdout.trim();
  rpc = new RpcChild({
    binary,
    args: ["app-server", "--listen", "stdio://"],
    cwd: root,
    env,
    requestTimeoutMs: 5000,
    maxOutputBytes: 1024 * 1024,
  });
  const result = await rpc.request("initialize", {
    clientInfo: {
      name: "vims_native_probe",
      title: "VIMS Offline Protocol Probe",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      explicitGatewayOauth: true,
    },
  });
  if (!result || typeof result.userAgent !== "string")
    throw new Error("Malformed initialization acknowledgement");
  rpc.notify("initialized");
  report = {
    version,
    initialized: true,
    transport: "stdio",
    isolatedCodexHome: true,
    existingAuthFilesReadByVims: false,
    threadStartCalls: 0,
    turnStartCalls: 0,
    modelCalls: 0,
    platformFamily: result.platformFamily ?? null,
    platformOs: result.platformOs ?? null,
  };
} finally {
  await rpc?.close();
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

console.log(
  JSON.stringify(
    { ...report, processClosed: true, temporaryHomeRemoved: true },
    null,
    2,
  ),
);
