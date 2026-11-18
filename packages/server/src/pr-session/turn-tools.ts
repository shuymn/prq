import {
  asSchema,
  type FlexibleSchema,
  isLoopFinished,
  type LanguageModelCallEndEvent,
  type PrepareStepResult,
  type ToolSet,
} from "ai";

import { STREAM_TIMEOUT } from "./model.ts";
import { ContextRoom } from "./room.ts";
import { RUN_TOOL_DEFINITION, type SkillContext, SKILL_TOOL_DEFINITIONS, skillTools } from "./skill-tools.ts";
import { GIT_TOOL_DEFINITIONS, MIN_RESULT_CHARS, type ToolContext, workspaceTools } from "./tools.ts";
import { SCRIPT_TOOL_MS, WORKSPACE_CALL_MS } from "./workspace.ts";

// A cloud turn's tools (docs/design.md, Model context): one set, decided at the turn's start from its workspace and its
// skill list. The git tools with a workspace, the skill tools while a skill is registered (with or without a
// workspace), and run_skill_script with a workspace while a listed skill has a runnable entry. The same set gives the
// definitions its prefix counts and its fingerprints hash, and the tools it runs, so no tool reaches the provider
// uncounted.

// Which tools a turn is offered.
type Offered = { workspace: boolean; skills: boolean; scripts?: boolean };

function byName<T>([a]: [string, T], [b]: [string, T]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedByName<T>(entries: Record<string, T>): [string, T][] {
  return Object.entries(entries).toSorted(byName);
}

// The offered tools' definitions as the provider is sent them (each name, description and JSON schema, sorted by
// name), as JSON: what a turn's requests carry of its tools before any call. Empty when none is offered. Known before
// the workspace is prepared.
export async function toolDefinitionsJson(offered: Offered): Promise<string> {
  const entries = sortedByName<{ description: string; inputSchema: FlexibleSchema<unknown> }>({
    ...(offered.workspace ? GIT_TOOL_DEFINITIONS : {}),
    ...(offered.skills ? SKILL_TOOL_DEFINITIONS : {}),
    ...(offered.scripts === true ? RUN_TOOL_DEFINITION : {}),
  });
  if (entries.length === 0) {
    return "";
  }
  const definitions = await Promise.all(
    entries.map(async ([name, definition]) => ({
      name,
      description: definition.description,
      parameters: await asSchema(definition.inputSchema).jsonSchema,
    })),
  );
  return JSON.stringify(definitions);
}

// What a turn's streamText is given besides its model and context. Every turn loops until a step makes no tool call
// (no step limit for now: docs/design.md, Billing limits); the AI SDK's own default would end it after
// one step. Tool calls are bounded by the workspace backstop, through the abort signal each execute receives: a script
// run's is a minute past the Workspace's own bound on it, so the Workspace answers first.
export const TURN_LOOP = {
  stopWhen: isLoopFinished(),
  timeout: { ...STREAM_TIMEOUT, toolMs: WORKSPACE_CALL_MS, tools: { run_skill_scriptMs: SCRIPT_TOOL_MS } },
};

type ToolLoop = {
  tools: ToolSet;
  prepareStep: (options: { stepNumber: number }) => PrepareStepResult<ToolSet> | undefined;
  onLanguageModelCallEnd: (event: Pick<LanguageModelCallEndEvent, "usage" | "content">) => void;
  // Whether the tools were withdrawn, from some step on.
  withdrawn: () => boolean;
};

// A turn with tools: the offered set, sorted by name (the order the provider sees them in, for its prompt cache), and
// the one room that withdraws them all (no tools offered) when the next request would leave no room for a result, so
// the model answers from what it has read. Under toolChoice "none", which would keep the tool definitions in the cached
// prefix, a provider wrote its tool call as the answer's text (DeepSeek), and an answer the author can read is worth
// more than that prefix. The first request's size is `start`, the caller's: the context count when the session has a
// measurement, else the request's estimate. The room is measured again at the end of each model call, and tools run
// after it.
export function toolLoop(
  context: { code?: Omit<ToolContext, "room">; skills?: Omit<SkillContext, "room"> },
  window: number,
  start: number,
): ToolLoop {
  const room = new ContextRoom(window);
  const tools = Object.fromEntries(
    sortedByName({
      ...(context.code === undefined ? {} : workspaceTools({ ...context.code, room })),
      ...(context.skills === undefined ? {} : skillTools({ ...context.skills, room })),
    }),
  );
  room.start(start);
  let withdrawn = false;
  return {
    tools,
    prepareStep: () => {
      if (room.leftChars() >= MIN_RESULT_CHARS) {
        return undefined;
      }
      withdrawn = true;
      return { activeTools: [] };
    },
    onLanguageModelCallEnd: ({ usage, content }) => {
      room.measure(usage, JSON.stringify(content).length);
    },
    withdrawn: () => withdrawn,
  };
}
