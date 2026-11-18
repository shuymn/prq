import type { Job, PrDetails, PrRef } from "@prq/protocol";

import { instructionPart, withFacts } from "./prompt.ts";
import { runnableEntries, type TurnSkill } from "./skill-tools.ts";
import { toolDefinitionsJson } from "./turn-tools.ts";

// A cloud turn's instruction prefix (docs/design.md, Model context): its system message and the definitions of the
// tools it is offered, its instructions fixed at the turn's start. Compaction shrinks the conversation but never this,
// so the context count, the at-start cut and the check that the turn can run at all count it.
export type Prefix = {
  system: string;
  // The characters of the system message and of the tool definitions' JSON.
  chars: number;
  // SHA-256 (hex) of the system message's instruction part (the core's lines, the skill list and the host's prompt) and
  // the tool definitions. A context measurement is reused only under the fingerprint it was taken under, so a prompt
  // edit, a skill registered, removed or described anew, a switch to a kind with another prompt or a turn that gains
  // its tools is estimated rather than counted short. The pull request's facts and the job's lines are left out: they
  // change with every head while their size barely does.
  fingerprint: string;
  // The fingerprint of the same instruction part without the tool definitions: what a request whose tools were
  // withdrawn carried. The fingerprint itself for a turn without tools.
  bare: string;
  // The characters of the tool definitions' JSON (none without tools).
  toolChars: number;
};

// What of a turn's prefix holds for the whole turn, built once at its start: whether it has the workspace's tools, the
// skills it lists, whether it runs their scripts (a workspace, and a runnable entry), the system message's instruction
// part as rendered, whether any tool is offered, the offered tools' definitions as JSON and the fingerprints, which
// leave the pull request's facts out.
export type TurnInstructions = {
  workspace: boolean;
  skills: readonly TurnSkill[];
  scripts: boolean;
  instructions: string;
  tools: boolean;
  definitions: string;
  fingerprint: string;
  bare: string;
};

export async function turnInstructions(
  job: Job,
  { workspace, skills, hostPrompt }: { workspace: boolean; skills: readonly TurnSkill[]; hostPrompt: string },
): Promise<TurnInstructions> {
  const scripts = workspace && skills.some((skill) => runnableEntries(skill).length > 0);
  const instructions = instructionPart({ kind: job.target.kind, tools: workspace, skills, scripts, hostPrompt });
  const definitions = await toolDefinitionsJson({ workspace, skills: skills.length > 0, scripts });
  const tools = definitions !== "";
  const fingerprint = await fingerprintOf(instructions, definitions);
  const bare = tools ? await fingerprintOf(instructions, "") : fingerprint;
  return { workspace, skills, scripts, instructions, tools, definitions, fingerprint, bare };
}

// The turn's prefix with the pull request's facts as `details` holds them.
export function prefixWith(turn: TurnInstructions, input: { pr: PrRef; details: PrDetails | null; job: Job }): Prefix {
  const text = withFacts(turn.instructions, { ...input, tools: turn.workspace });
  const { fingerprint, bare, definitions } = turn;
  return { system: text, chars: text.length + definitions.length, fingerprint, bare, toolChars: definitions.length };
}

// A prefix built in one go, outside a turn (tests and the tools report): `tools` is whether the turn has the
// workspace's tools.
export async function instructionPrefix(input: {
  pr: PrRef;
  details: PrDetails | null;
  job: Job;
  tools: boolean;
  skills?: readonly TurnSkill[];
  hostPrompt: string;
}): Promise<Prefix> {
  const { job, tools, skills = [], hostPrompt } = input;
  return prefixWith(await turnInstructions(job, { workspace: tools, skills, hostPrompt }), input);
}

async function fingerprintOf(instructions: string, definitions: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([instructions, definitions])),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
