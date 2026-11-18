// What a cloud turn's model requests carry of the skill tools: the system message, the tool calls and results, the
// definitions, and the status lines and markers the server writes.

import type { Skill } from "@prq/protocol";

import { type CallOptions, finish, type Script, toolCall } from "./model.ts";

export function systemOf(call: CallOptions | undefined): string {
  const [first] = call?.prompt ?? [];
  if (first?.role !== "system") {
    throw new Error("the call has no system message");
  }
  return first.content;
}

// The tool calls and the tool results a request carries, in order.
export function toolTraffic(call: CallOptions | undefined) {
  const calls: { toolName: string; input: unknown }[] = [];
  const results: { toolName: string; text: string }[] = [];
  for (const message of call?.prompt ?? []) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call") {
          calls.push({ toolName: part.toolName, input: part.input });
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          const { output } = part;
          results.push({
            toolName: part.toolName,
            text: output.type === "text" ? output.value : JSON.stringify(output),
          });
        }
      }
    }
  }
  return { calls, results };
}

// The tool definitions a request carries, as toolDefinitionsJson writes them.
export function sentDefinitions(call: CallOptions | undefined): string {
  const tools = call?.tools ?? [];
  return tools.length === 0
    ? ""
    : JSON.stringify(
        tools.map((entry) =>
          entry.type === "function"
            ? { name: entry.name, description: entry.description, parameters: entry.inputSchema }
            : entry,
        ),
      );
}

export function toolNames(call: CallOptions | undefined): string[] {
  return (call?.tools ?? []).map((entry) => entry.name);
}

export function marker(tool: string, skill: Skill, outcome = "read"): string {
  return (
    `[${tool} of skill ${skill.name} at ${skill.sha.slice(0, 7)} rev ${skill.rev} in an earlier turn: ${outcome}; ` +
    "activate the skill again to use it]"
  );
}

export function statusOf(tool: string, skill: Skill, outcome = "read"): string {
  return `[${tool} skill ${skill.name} at ${skill.sha} rev ${skill.rev}: ${outcome}]`;
}

export function toolStep(name: string, input: Record<string, unknown>, id: string, tokens = {}): Script {
  return [toolCall(name, input, id), finish("tool-calls", tokens)];
}
