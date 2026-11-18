import type { Job, PrDetails, PrRef } from "@prq/protocol";

import { systemPrompt } from "./prompt.ts";
import { toolDefinitionsJson } from "./tools.ts";

// A cloud turn's instruction prefix (docs/design.md, Model context): its system message and the definitions of the
// tools it is offered, fixed at the turn's start. Compaction shrinks the conversation but never this, so the context
// count, the at-start cut and the check that the turn can run at all count it.
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

export async function instructionPrefix(input: {
  pr: PrRef;
  details: PrDetails | null;
  job: Job;
  tools: boolean;
  hostPrompt: string;
}): Promise<Prefix> {
  const system = systemPrompt(input);
  const definitions = input.tools ? await toolDefinitionsJson() : "";
  return {
    system: system.text,
    chars: system.text.length + definitions.length,
    fingerprint: await fingerprintOf(system.instructions, definitions),
    bare: await fingerprintOf(system.instructions, ""),
    toolChars: definitions.length,
  };
}

async function fingerprintOf(instructions: string, definitions: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([instructions, definitions])),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
