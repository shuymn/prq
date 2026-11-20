// The setup's state file (setup.json in the state directory): what a step records between runs, such as the
// rehearsal's run or the GitHub App's pending registration. The directory and the file are the owner's alone; the file
// is written whole beside it and renamed over it.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fixture } from "./fixture.ts";
import { mode, Refusal, stateRoot } from "./operations.ts";

const STATE_FILE = "setup.json";
// Only the tests' fixture sets the state directory.
const stateDirectory = fixture.stateDir ?? join(stateRoot(), "prq");

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown error";
}

// The state directory's missing ancestors, then the directory, each made 0700 whatever the umask.
async function makeStateDirectory(): Promise<void> {
  const missing: string[] = [];
  for (let each = stateDirectory; (await lstat(each).catch(() => null)) === null; each = dirname(each)) {
    missing.unshift(each);
  }
  for (const each of missing) {
    try {
      await mkdir(each, { mode: 0o700 });
      await chmod(each, 0o700);
    } catch (error) {
      throw new Refusal(`could not make the state directory ${each} (${errorCode(error)})`);
    }
  }
}

// The state directory, the owner's alone and not a symbolic link; made when missing and make is set. Null when it is
// missing.
async function stateDir(make: boolean): Promise<string | null> {
  if (make) {
    await makeStateDirectory();
  }
  const info = await lstat(stateDirectory).catch(() => null);
  if (info === null) {
    return null;
  }
  if (!info.isDirectory()) {
    throw new Refusal(`the state directory ${stateDirectory} is not a directory`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Refusal(
      `the state directory ${stateDirectory} is open to others than its owner (mode ${mode(info.mode)}): chmod 700 it`,
    );
  }
  return stateDirectory;
}

// The setup's state file as an object: empty when there is none.
export async function readState(): Promise<Record<string, unknown>> {
  const dir = await stateDir(false);
  if (dir === null) {
    return {};
  }
  let handle;
  try {
    handle = await open(join(dir, STATE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Refusal(`could not read ${STATE_FILE} in ${dir}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Refusal(`${STATE_FILE} in ${dir} is not a regular file of the owner's alone`);
    }
    const state: unknown = JSON.parse(await handle.readFile("utf8"));
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new Refusal(`${STATE_FILE} in ${dir} does not hold a JSON object`);
    }
    return { ...state };
  } catch (error) {
    throw error instanceof Refusal ? error : new Refusal(`${STATE_FILE} in ${dir} does not hold JSON`);
  } finally {
    await handle.close();
  }
}

// The state file with key set, the rest kept: written whole beside it (0600 whatever the umask, a new file), then
// renamed over it. A failure is a refusal naming the file, the new file removed.
export async function recordState(key: string, value: unknown): Promise<void> {
  const state = { ...(await readState()), [key]: value };
  const dir = (await stateDir(true)) ?? stateDirectory;
  const temp = join(dir, `.${STATE_FILE}.${randomBytes(6).toString("hex")}`);
  let created = false;
  try {
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(temp, join(dir, STATE_FILE));
  } catch (error) {
    if (created) {
      await unlink(temp).catch(() => {});
    }
    throw new Refusal(`could not write ${STATE_FILE} in ${dir} (${errorCode(error)}); it is as it was`);
  }
}
