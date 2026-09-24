import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const IDENTITY = ["-c", "user.name=substrate", "-c", "user.email=substrate@localhost"];

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...IDENTITY, ...args], { cwd });
  return stdout;
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 只提交指定路徑，避免把使用者手動編輯中的檔案一併捲入。
 * stdio 模式下可能有多個行程同時寫入同一個 vault，遇到 index.lock 時退避重試。
 */
export async function commitPaths(cwd: string, paths: string[], message: string): Promise<void> {
  if (paths.length === 0) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await git(cwd, ["add", "--", ...paths]);
      const staged = await git(cwd, ["diff", "--cached", "--name-only", "--", ...paths]);
      if (!staged.trim()) return;
      await git(cwd, ["commit", "--quiet", "-m", message, "--", ...paths]);
      return;
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? err);
      if (attempt < 5 && msg.includes("index.lock")) {
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}
