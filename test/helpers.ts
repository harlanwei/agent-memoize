import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const sh = promisify(execFile);

export async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "memoize-test-"));
}

export async function gitRepo(): Promise<string> {
  const dir = await tmpDir();
  await sh("git", ["init", "-q"], { cwd: dir });
  return dir;
}

export async function commitAll(dir: string, msg = "commit"): Promise<void> {
  await sh("git", ["add", "-A"], { cwd: dir });
  await sh(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", msg],
    { cwd: dir },
  );
}

export async function write(root: string, rel: string, content: string): Promise<void> {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}
