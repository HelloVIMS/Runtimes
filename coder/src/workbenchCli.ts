import { CodexAppServerDriver } from "./codexAppServer.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoderCore } from "./core.ts";
import { CodexExecDriver } from "./processDriver.ts";
import {
  startWorkbench,
  type WorkbenchProject,
  type WorkbenchProfile,
} from "./workbench.ts";
import { identifier, text } from "./store.ts";
export interface WorkbenchConfig {
  stateDirectory: string;
  port?: number;
  projects: WorkbenchProject[];
  profiles: WorkbenchProfile[];
  drivers: Array<{
    id: string;
    binary: string;
    allowWorkspaceWrites: boolean;
    transport: "exec-jsonl" | "app-server-stdio";
  }>;
}
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration entry must be an object");
  return value as Record<string, unknown>;
};
const exact = (value: object, keys: readonly string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unknown configuration field");
};
const absolute = (value: unknown, name: string) => {
  const result = text(value, name, 4096);
  if (!path.isAbsolute(result)) throw new Error(`${name} must be absolute`);
  return result;
};
export function parseWorkbenchConfig(raw: unknown): WorkbenchConfig {
  const value = record(raw);
  exact(value, ["stateDirectory", "port", "projects", "profiles", "drivers"]);
  const stateDirectory = absolute(value.stateDirectory, "stateDirectory");
  if (
    value.port !== undefined &&
    (typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      value.port < 0 ||
      value.port > 65535)
  )
    throw new Error("Invalid port");
  const list = (name: string) => {
    const entries = value[name];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32)
      throw new Error(`${name} must contain 1ΓÇô32 entries`);
    return entries.map(record);
  };
  const drivers = list("drivers").map((item) => {
    exact(item, ["id", "binary", "allowWorkspaceWrites", "transport"]);
    if (
      item.transport !== undefined &&
      !["exec-jsonl", "app-server-stdio"].includes(String(item.transport))
    )
      throw new Error("Unsupported native transport");
    const binary = absolute(item.binary, "native executable");
    if (/\.(bat|cmd|ps1)$/i.test(binary))
      throw new Error("Select a native Codex executable, not a shell launcher");
    if (
      item.allowWorkspaceWrites !== undefined &&
      typeof item.allowWorkspaceWrites !== "boolean"
    )
      throw new Error("allowWorkspaceWrites must be boolean");
    return {
      id: identifier(item.id),
      binary,
      allowWorkspaceWrites: item.allowWorkspaceWrites === true,
      transport: (item.transport ?? "exec-jsonl") as
        | "exec-jsonl"
        | "app-server-stdio",
    };
  });
  if (new Set(drivers.map((d) => d.id)).size !== drivers.length)
    throw new Error("Duplicate driver id");
  const profiles = list("profiles").map((item) => {
    exact(item, ["id", "name", "driverId", "model"]);
    const driverId = identifier(item.driverId);
    if (!drivers.some((driver) => driver.id === driverId))
      throw new Error("Profile references an unknown driver");
    return {
      id: identifier(item.id),
      name: text(item.name, "profile name", 128),
      driverId,
      model: text(item.model, "model", 256),
    };
  });
  const projects = list("projects").map((item) => {
    exact(item, ["id", "name", "repository"]);
    return {
      id: identifier(item.id),
      name: text(item.name, "project name", 128),
      repository: absolute(item.repository, "repository"),
    };
  });
  return {
    stateDirectory,
    drivers,
    profiles,
    projects,
    ...(value.port !== undefined ? { port: value.port as number } : {}),
  };
}
export async function launchConfiguredWorkbench(config: WorkbenchConfig) {
  for (const driver of config.drivers) {
    const stat = await fs.stat(driver.binary);
    if (!stat.isFile())
      throw new Error("Configured native executable is not a file");
  }
  const drivers = config.drivers.map((driver) =>
    driver.transport === "app-server-stdio"
      ? new CodexAppServerDriver(driver.id, driver.binary, {
          allowWorkspaceWrites: driver.allowWorkspaceWrites,
        })
      : new CodexExecDriver(driver.id, driver.binary, {
          allowWorkspaceWrites: driver.allowWorkspaceWrites,
        }),
  );
  const core = new CoderCore(config.stateDirectory, drivers);
  try {
    const workbench = await startWorkbench({
      core,
      projects: config.projects,
      profiles: config.profiles,
      port: config.port,
    });
    return {
      ...workbench,
      core,
      async close() {
        await workbench.close();
        core.close();
      },
    };
  } catch (error) {
    core.close();
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: node dist/workbenchCli.js --config /absolute/path/to/private-config.json\nSee examples/workbench.config.example.json. Binds only 127.0.0.1; explicit task approval required.",
    );
    return;
  }
  if (args.length !== 2 || args[0] !== "--config")
    throw new Error("Use --config PATH, or --help");
  const file = path.resolve(args[1]!);
  const stat = await fs.stat(file);
  if (stat.size > 65536) throw new Error("Configuration exceeds 64 KiB");
  const config = parseWorkbenchConfig(
    JSON.parse(await fs.readFile(file, "utf8")),
  );
  const workbench = await launchConfiguredWorkbench(config);
  console.log(
    "Native providers may use your existing model quota. No task starts before approval. This local control token is private:",
  );
  console.log(`${workbench.url}/#${workbench.token}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void workbench.close().catch((error) => {
      console.error(error instanceof Error ? error.message : "Shutdown failed");
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  void main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Could not start native workbench",
    );
    process.exitCode = 1;
  });
