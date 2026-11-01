import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { parseTurnDiffFilesFromNumstat } from "./t3/Diffs.ts";
import type { Thread } from "./types.ts";
const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Git snapshots are owned by VIMS; no T3 process, metadata directory or service. */
export class Workspaces {
  constructor(readonly root: string) {}
  private async git(
    cwd: string,
    args: string[],
    env: Record<string, string> = {},
  ): Promise<string> {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => !key.startsWith("GIT_") && value !== undefined,
      ),
    ) as Record<string, string>;
    const result = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=" + path.join(this.root, ".no-hooks"),
        "-C",
        cwd,
        ...args,
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
        env: { ...clean, ...env },
        windowsHide: true,
      },
    );
    return result.stdout;
  }
  async repository(input: string): Promise<string> {
    const root = await fs.realpath(input);
    const top = (await this.git(root, ["rev-parse", "--show-toplevel"])).trim();
    if ((await fs.realpath(top)) !== root)
      throw new Error("repository must be the exact Git worktree root");
    const internal = path.relative(root, path.resolve(this.root));
    if (
      internal === "" ||
      (!internal.startsWith(".." + path.sep) &&
        internal !== ".." &&
        !path.isAbsolute(internal))
    )
      throw new Error("VIMS state/worktrees must be outside the project");
    return root;
  }
  async ensure(thread: Thread): Promise<string> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.root, ".no-hooks"), { recursive: true });
    if (!UUID.test(thread.id)) throw new Error("invalid workspace owner id");
    const target = path.join(this.root, thread.id);
    const list = await this.git(thread.repository, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const registered = list
      .split("\0")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice(9)));
    if (registered.includes(path.resolve(target))) {
      const info = await fs.lstat(target);
      if (info.isSymbolicLink())
        throw new Error("owned worktree must not be a symlink");
      return await fs.realpath(target);
    }
    try {
      await fs.lstat(target);
      throw new Error("refusing an existing unregistered worktree path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Resolve first: caller-controlled refs cannot become worktree-add flags.
    const ref = (
      await this.git(thread.repository, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        thread.baseRef + "^{commit}",
      ])
    ).trim();
    if (!SHA.test(ref)) throw new Error("base ref is not a commit");
    await this.git(thread.repository, [
      "worktree",
      "add",
      "--detach",
      target,
      ref,
    ]);
    return await fs.realpath(target);
  }
  async assertOwned(thread: Thread): Promise<string> {
    if (!thread.worktree) throw new Error("thread has no isolated worktree");
    if (!UUID.test(thread.id)) throw new Error("invalid workspace owner id");
    const target = path.join(this.root, thread.id);
    if ((await fs.lstat(target)).isSymbolicLink())
      throw new Error("owned worktree was replaced by a symlink");
    const actual = await fs.realpath(target);
    if (
      actual !== (await fs.realpath(thread.worktree)) ||
      actual === thread.repository
    )
      throw new Error("workspace ownership mismatch");
    const list = await this.git(thread.repository, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (
      !list
        .split("\0")
        .some((row) => row === "worktree " + actual.replaceAll("\\", "/")) &&
      !list.split("\0").some((row) => row === "worktree " + actual)
    )
      throw new Error("worktree is not registered to the project");
    return actual;
  }
  async capture(
    thread: Thread,
    runId: string,
    phase: "before" | "after",
  ): Promise<string> {
    if (!UUID.test(runId)) throw new Error("invalid checkpoint run id");
    const cwd = await this.assertOwned(thread);
    const temp = await fs.mkdtemp(path.join(this.root, ".index-"));
    const env = { GIT_INDEX_FILE: path.join(temp, "index") };
    try {
      await this.git(cwd, ["read-tree", "HEAD"], env);
      await this.git(cwd, ["add", "-A", "--", "."], env);
      const tree = (await this.git(cwd, ["write-tree"], env)).trim();
      const head = (await this.git(cwd, ["rev-parse", "HEAD"])).trim();
      const commit = (
        await this.git(cwd, [
          "-c",
          "user.name=VIMS checkpoints",
          "-c",
          "user.email=checkpoints@localhost",
          "commit-tree",
          tree,
          "-p",
          head,
          "-m",
          `VIMS ${runId} ${phase}`,
        ])
      ).trim();
      if (!SHA.test(commit))
        throw new Error("checkpoint did not produce a commit");
      await this.git(cwd, [
        "update-ref",
        `refs/vims/checkpoints/${thread.id}/${runId}/${phase}`,
        commit,
      ]);
      return commit;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  /** Verify a recorded checkpoint ref, never resolve a caller-selected arbitrary commit. */
  async checkpoint(
    thread: Thread,
    runId: string,
    phase: "before" | "after",
    expected: string,
  ): Promise<string> {
    if (
      !UUID.test(thread.id) ||
      !UUID.test(runId) ||
      !["before", "after"].includes(phase) ||
      !SHA.test(expected)
    )
      throw new Error("invalid checkpoint identity");
    const ref = `refs/vims/checkpoints/${thread.id}/${runId}/${phase}`;
    const actual = (
      await this.git(thread.repository, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        ref + "^{commit}",
      ])
    ).trim();
    if (actual !== expected)
      throw new Error("checkpoint ref no longer matches the recorded snapshot");
    return actual;
  }
  async review(thread: Thread, before: string, after: string) {
    const cwd = await this.assertOwned(thread);
    if (!SHA.test(before) || !SHA.test(after))
      throw new Error("invalid checkpoint id");
    const args = ["diff", "--no-ext-diff", "--no-textconv", before, after];
    const numstat = await this.git(cwd, [...args, "--numstat", "-z", "--"]);
    const patch = await this.git(cwd, [...args, "--binary", "--"]);
    return {
      before,
      after,
      files: parseTurnDiffFilesFromNumstat(numstat),
      patch,
    };
  }
  /** Remove only an explicitly confirmed, clean owned worktree; never git clean/reset. */
  async remove(thread: Thread, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("explicit cleanup confirmation required");
    const cwd = await this.assertOwned(thread);
    if (
      (
        await this.git(cwd, ["status", "--porcelain", "--untracked-files=all"])
      ).trim()
    )
      throw new Error("refusing to remove a dirty worktree");
    await this.git(thread.repository, ["worktree", "remove", cwd]);
  }
}
