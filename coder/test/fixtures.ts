import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CoderCore } from "../src/core.ts";
import type { NativeDriver } from "../src/types.ts";
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}
export async function fixture(drivers: NativeDriver[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vims-native-test-"));
  const repo = path.join(root, "repository");
  await fs.mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@localhost");
  git(repo, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(repo, "code.txt"), "baseline\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "*.secret\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  const state = path.join(root, "state");
  const core = new CoderCore(state, drivers);
  return {
    root,
    repo,
    state,
    core,
    cleanup: async () => {
      core.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
