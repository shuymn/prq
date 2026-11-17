import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

// The CLI's local state under the state root:
//   agents/<sha256(agentId) hex>.json        the agent's current claim
//   jobs/<jobId>-r<run>-<workspaceSha|none>/ one claim's work: its job, run and workspace
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
    return join(this.#home, "agents", `${createHash("sha256").update(this.#agentId).digest("hex")}.json`);
  }

  // The directory of a claim's work. A claim that resumes the same job, run and workspace names the same directory; a
  // retry or a moved workspace names another.
  jobDir(job: Job): string {
    return join(this.#home, "jobs", `${job.jobId}-r${job.run}-${job.workspaceSha ?? "none"}`);
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

  // Writes the record through a temporary file and a rename, so a reader sees the old record or the new one.
  async saveRecord(claim: Claim): Promise<void> {
    const path = this.recordPath;
    await mkdir(join(this.#home, "agents"), { recursive: true, mode: 0o700 });
    const record: v.InferOutput<typeof ClaimRecord> = {
      agentId: this.#agentId,
      claim,
      savedAt: new Date().toISOString(),
    };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async removeRecord(): Promise<void> {
    await rm(this.recordPath, { force: true });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
