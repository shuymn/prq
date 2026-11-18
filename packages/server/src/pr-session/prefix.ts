import type { Job, PrDetails, PrRef } from "@prq/protocol";

import { instructionPart, systemPrompt } from "./prompt.ts";
import { toolDefinitionsJson } from "./tools.ts";

// A cloud turn's instruction prefix (docs/design.md, Model context): its system message and the definitions of the
// tools it is offered, its instructions fixed at the turn's start. Compaction shrinks the conversation but never this,
// so the context count, the at-start cut and the check that the turn can run at all count it.
export type Prefix = {
  system: string;
  // The characters of the system message and of the tool definitions' JSON.
  chars: number;
  // SHA-256 (hex) of the system message's instruction part (the core's lines and the host's prompt) and the tool
  // definitions. A context measurement is reused only under the fingerprint it was taken under, so a prompt edit, a
  // switch to a kind with another prompt or a turn that gains its tools is estimated rather than counted short. The pull
  // request's facts and the job's lines are left out: they change with every head while their size barely does.
  fingerprint: string;
  // The fingerprint of the same instruction part without the tool definitions: what a request whose tools were
  // withdrawn carried. The fingerprint itself for a turn without tools.
  bare: string;
  // The characters of the tool definitions' JSON (none without tools).
  toolChars: number;
};

// What of a turn's prefix holds for the whole turn, built once at its start: whether it has tools, the host's prompt,
// the tool definitions' JSON and the fingerprints, which leave the pull request's facts out.
export type TurnInstructions = {
  tools: boolean;
  hostPrompt: string;
  definitions: string;
  fingerprint: string;
  bare: string;
};

export async function turnInstructions(job: Job, tools: boolean, hostPrompt: string): Promise<TurnInstructions> {
  const instructions = instructionPart({ kind: job.target.kind, tools, hostPrompt });
  const definitions = tools ? await toolDefinitionsJson() : "";
  const fingerprint = await fingerprintOf(instructions, definitions);
  const bare = tools ? await fingerprintOf(instructions, "") : fingerprint;
  return { tools, hostPrompt, definitions, fingerprint, bare };
}

// The turn's prefix with the pull request's facts as `details` holds them.
export function prefixWith(turn: TurnInstructions, input: { pr: PrRef; details: PrDetails | null; job: Job }): Prefix {
  const { text } = systemPrompt({ ...input, tools: turn.tools, hostPrompt: turn.hostPrompt });
  const { fingerprint, bare, definitions } = turn;
  return { system: text, chars: text.length + definitions.length, fingerprint, bare, toolChars: definitions.length };
}

// A prefix built in one go, outside a turn (tests and the tools report).
export async function instructionPrefix(input: {
  pr: PrRef;
  details: PrDetails | null;
  job: Job;
  tools: boolean;
  hostPrompt: string;
}): Promise<Prefix> {
  return prefixWith(await turnInstructions(input.job, input.tools, input.hostPrompt), input);
}

async function fingerprintOf(instructions: string, definitions: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([instructions, definitions])),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
