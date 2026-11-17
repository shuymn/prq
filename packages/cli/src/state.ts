import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentId, ClaimResponse, type Job } from "@prq/protocol";
import * as v from "valibot";

import { CliError, EXIT } from "./errors.ts";

// A record that does not parse as the agent's: it is not used, and the next claim replaces it.
export class UnreadableRecord extends CliError {
  constructor(path: string) {
    super(EXIT.error, `the claim record ${path} is unreadable; run prq claim`);
  }
}

// A claim that holds a job: the job, its claimId and whether it was resumed.
const Claim = ClaimResponse.options[0];
export type Claim = v.InferOutput<typeof Claim>;

// The agent's current claim, the one place a claimId lives between processes (docs/design.md, Local CLI).
const ClaimRecord = v.object({ agentId: AgentId, claim: Claim, savedAt: v.pipe(v.string(), v.isoTimestamp()) });

// A record as another agent's process reads it: the agent ID it names and its claim.
export type AgentRecord = { agentId: string; claim: Claim };

// A job directory's name: <jobId>-r<run>-<workspaceSha|none>.
export const JOB_DIR_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-r[1-9][0-9]*-([0-9a-f]{40}|none)$/;

// The CLI's local state under the state root:
//   agents/<sha256(agentId) hex>.json        the agent's current claim
//   jobs/<jobId>-r<run>-<workspaceSha|none>/ one claim's work: its job, run and workspace
//   git-hooks/                               empty: the hooks directory of every git call (git.ts)
// The record's file name is a hash: agent IDs are case-sensitive while macOS file systems usually are not, and an ID
// can contain `/`.
export class State {
  readonly #home: string;
  readonly #agentId: string;

  constructor(home: string, agentId: string) {
    this.#home = home;
    this.#agentId = agentId;
  }

  get recordPath(): string {
    return join(this.#home, "agents", recordName(this.#agentId));
  }

  get jobsDir(): string {
    return join(this.#home, "jobs");
  }

  get hooksDir(): string {
    return join(this.#home, "git-hooks");
  }

  // The directory of a claim's work. A claim that resumes the same job, run and workspace names the same directory; a
  // retry or a moved workspace names another.
  jobDir(job: Job): string {
    return join(this.jobsDir, `${job.jobId}-r${job.run}-${job.workspaceSha ?? "none"}`);
  }

  // The agent's record, or null when it has none. An unreadable record ends the command.
  async readRecord(): Promise<Claim | null> {
    let text: string;
    try {
      text = await readFile(this.recordPath, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    const record = v.safeParse(ClaimRecord, parseJson(text));
    if (!record.success || record.output.agentId !== this.#agentId) {
      throw new UnreadableRecord(this.recordPath);
    }
    return record.output.claim;
  }

  // The agent's record, which context and submit work under; none ends the command.
  async claimed(): Promise<Claim> {
    const claim = await this.readRecord();
    if (claim === null) {
      throw new CliError(EXIT.error, `no claim is saved for agent ${this.#agentId}; run prq claim`);
    }
    return claim;
  }

  async saveRecord(claim: Claim): Promise<void> {
    await mkdir(join(this.#home, "agents"), { recursive: true, mode: 0o700 });
    const record: v.InferOutput<typeof ClaimRecord> = {
      agentId: this.#agentId,
      claim,
      savedAt: new Date().toISOString(),
    };
    await writeAtomically(this.recordPath, `${JSON.stringify(record)}\n`);
  }

  // Every agent's record, and the paths of those that do not parse as the agent their file is named for.
  async allRecords(): Promise<{ records: AgentRecord[]; unreadable: string[] }> {
    const dir = join(this.#home, "agents");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) {
        return { records: [], unreadable: [] };
      }
      throw error;
    }
    const records: AgentRecord[] = [];
    const unreadable: string[] = [];
    for (const name of names.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry)).toSorted()) {
      const path = join(dir, name);
      let text: string | undefined;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        // A record removed since the listing names nothing.
        if (isMissing(error)) {
          continue;
        }
        throw error;
      }
      const record = v.safeParse(ClaimRecord, parseJson(text));
      if (record.success && recordName(record.output.agentId) === name) {
        records.push({ agentId: record.output.agentId, claim: record.output.claim });
      } else {
        unreadable.push(path);
      }
    }
    return { records, unreadable };
  }

  async removeRecord(): Promise<void> {
    await rm(this.recordPath, { force: true });
  }
}

// Writes a file through a temporary file and a rename, so a reader sees the old file or the new one, never a part.
export async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flush: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// A regular file's JSON, or undefined: missing, a symlink, not JSON.
export async function readJson(path: string): Promise<unknown> {
  try {
    if (!(await lstat(path)).isFile()) {
      return undefined;
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function recordName(agentId: string): string {
  return `${createHash("sha256").update(agentId).digest("hex")}.json`;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
