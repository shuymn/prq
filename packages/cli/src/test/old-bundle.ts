// An earlier deploy's web UI for the browser check (plan §5.2): the current source built with another version
// (PRQ_BUILD_VERSION) and a prefix on every emitted file's name (PRQ_BUILD_PREFIX), into a fresh directory of the OS
// temp directory, so that none of its files exist among the Worker's assets. The door serves it (door.ts serve()) until
// the test switches it off.
//
// The build is bounded: past OLD_BUNDLE_MS, or once the caller's signal aborts, it is killed. A build that fails, is
// killed or cannot start removes its directory, once its process has ended, before the error is thrown; close() removes
// a built one.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OLD_VERSION = "v0.0.0-old";
const OLD_PREFIX = "old-";
const OLD_BUNDLE_MS = 120_000;

const SERVER = fileURLToPath(new URL("../../../server/", import.meta.url));

type OldBundle = { dir: string; close(): Promise<void> };

// The command that builds into a directory: the server package's Vite.
type Command = (outDir: string) => { file: string; args: string[] };

const viteBuild: Command = (outDir) => {
  const vite = join(dirname(createRequire(join(SERVER, "package.json")).resolve("vite/package.json")), "bin/vite.js");
  return { file: process.execPath, args: [vite, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"] };
};

export async function buildOldBundle({
  timeoutMs = OLD_BUNDLE_MS,
  command = viteBuild,
  signal,
}: { timeoutMs?: number; command?: Command; signal?: AbortSignal | undefined } = {}): Promise<OldBundle> {
  const dir = await mkdtemp(join(tmpdir(), "prq-old-bundle-"));
  const remove = () => rm(dir, { recursive: true, force: true });
  try {
    const { file, args } = command(dir);
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        file,
        args,
        {
          cwd: SERVER,
          env: { ...process.env, PRQ_BUILD_VERSION: OLD_VERSION, PRQ_BUILD_PREFIX: OLD_PREFIX },
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          signal,
        },
        (error, _stdout, stderr) => {
          if (error === null) {
            resolve();
          } else {
            const ending = signal?.aborted
              ? "was cancelled"
              : error.killed
                ? `was killed after ${timeoutMs} ms`
                : `failed (${error.code ?? error.signal})`;
            const failure = new Error(`the old bundle's build ${ending}: ${stderr.trim()}`);
            // A cancel calls back as it kills the build: the error waits for the process to end.
            if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
              child.once("exit", () => reject(failure));
            } else {
              reject(failure);
            }
          }
        },
      );
    });
  } catch (error) {
    await remove();
    throw error;
  }
  return { dir, close: remove };
}
