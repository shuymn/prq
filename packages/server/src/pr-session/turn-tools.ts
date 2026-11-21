import { valibotSchema } from "@ai-sdk/valibot";
import {
  asSchema,
  type FlexibleSchema,
  type LanguageModelCallEndEvent,
  type PrepareStepResult,
  type StopCondition,
  tool,
  type ToolSet,
} from "ai";
import * as v from "valibot";

import { STREAM_TIMEOUT } from "./model.ts";
import { ContextRoom } from "./room.ts";
import { RUN_TOOL_DEFINITION, type SkillContext, SKILL_TOOL_DEFINITIONS, skillTools } from "./skill-tools.ts";
import { GIT_TOOL_DEFINITIONS, MIN_RESULT_CHARS, type ToolContext, workspaceTools } from "./tools.ts";
import { SCRIPT_TOOL_MS, WORKSPACE_CALL_MS } from "./workspace.ts";

// A cloud turn's tools (docs/design.md, Model context): one set, decided at the turn's start from its workspace and its
// skill list. publish in every turn, the git tools with a workspace, the skill tools while a skill is registered (with
// or without a workspace), and run_skill_script with a workspace while a listed skill has a runnable entry. The same
// set gives the definitions its prefix counts and its fingerprints hash, and the tools it runs, so no tool reaches the
// provider uncounted.

// Which tools a turn is offered besides publish.
type Offered = { workspace: boolean; skills: boolean; scripts?: boolean };

export const PUBLISH = "publish";

const PublishInput = v.object({
  text: v.pipe(v.string(), v.description("The complete answer, in Markdown")),
});

// The tool that delivers a turn's answer: its text is the result stored, and its call ends the turn. It is never
// withdrawn.
const PUBLISH_TOOL_DEFINITION = {
  [PUBLISH]: {
    description:
      "Deliver your answer: the complete text the reader sees, in Markdown. Call it once, when the answer is done; " +
      "it ends your turn, and text written outside it is not shown.",
    inputSchema: valibotSchema(PublishInput),
  },
};

function byName<T>([a]: [string, T], [b]: [string, T]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedByName<T>(entries: Record<string, T>): [string, T][] {
  return Object.entries(entries).toSorted(byName);
}

// The offered tools' definitions as the provider is sent them (each name, description and JSON schema, sorted by
// name), as JSON: what a turn's requests carry of its tools before any call, publish always among them. Known before
// the workspace is prepared.
export async function toolDefinitionsJson(offered: Offered): Promise<string> {
  const entries = sortedByName<{ description: string; inputSchema: FlexibleSchema<unknown> }>({
    ...PUBLISH_TOOL_DEFINITION,
    ...(offered.workspace ? GIT_TOOL_DEFINITIONS : {}),
    ...(offered.skills ? SKILL_TOOL_DEFINITIONS : {}),
    ...(offered.scripts === true ? RUN_TOOL_DEFINITION : {}),
  });
  const definitions = await Promise.all(
    entries.map(async ([name, definition]) => ({
      name,
      description: definition.description,
      parameters: await asSchema(definition.inputSchema).jsonSchema,
    })),
  );
  return JSON.stringify(definitions);
}

// A turn ends at the step whose publish call ran: an input the tool refused (no text) goes back to the model as an
// error, and the turn goes on.
const published: StopCondition<ToolSet> = ({ steps }) =>
  steps.at(-1)?.toolResults.some((result) => result.toolName === PUBLISH) ?? false;

// What a turn's streamText is given besides its model and context. Every turn loops until a step's publish call ran,
// or a step makes no tool call (no step limit for now: docs/design.md, Billing limits); the AI SDK's own default would
// end it after one step. Tool calls are bounded by the workspace backstop, through the abort signal each execute
// receives: a script run's is a minute past the Workspace's own bound on it, so the Workspace answers first.
export const TURN_LOOP = {
  stopWhen: published,
  timeout: { ...STREAM_TIMEOUT, toolMs: WORKSPACE_CALL_MS, tools: { run_skill_scriptMs: SCRIPT_TOOL_MS } },
};

type ToolLoop = {
  tools: ToolSet;
  prepareStep: (options: { stepNumber: number }) => PrepareStepResult<ToolSet> | undefined;
  onLanguageModelCallEnd: (event: Pick<LanguageModelCallEndEvent, "usage" | "content">) => void;
  // Whether the tools that read were withdrawn, from some step on.
  withdrawn: () => boolean;
};

// A turn's tools: the offered set, sorted by name (the order the provider sees them in, for its prompt cache), and the
// one room that withdraws all of them but publish when the next request would leave no room for a result, so the model
// answers from what it has read. Under toolChoice "none", which would keep the tool definitions in the cached prefix, a
// provider wrote its tool call as the answer's text (DeepSeek), and an answer the author can read is worth more than
// that prefix. The first request's size is `start`, the caller's: the context count when the session has a
// measurement, else the request's estimate. The room is measured again at the end of each model call, and tools run
// after it.
export function toolLoop(
  context: { code?: Omit<ToolContext, "room">; skills?: Omit<SkillContext, "room"> },
  window: number,
  start: number,
): ToolLoop {
  const room = new ContextRoom(window);
  const reading = {
    ...(context.code === undefined ? {} : workspaceTools({ ...context.code, room })),
    ...(context.skills === undefined ? {} : skillTools({ ...context.skills, room })),
  };
  const withdrawable = Object.keys(reading).length > 0;
  const tools = Object.fromEntries(sortedByName({ ...reading, ...publishTool() }));
  room.start(start);
  let withdrawn = false;
  return {
    tools,
    prepareStep: () => {
      if (!withdrawable || room.leftChars() >= MIN_RESULT_CHARS) {
        return undefined;
      }
      withdrawn = true;
      return { activeTools: [PUBLISH] };
    },
    onLanguageModelCallEnd: ({ usage, content }) => {
      room.measure(usage, JSON.stringify(content).length);
    },
    withdrawn: () => withdrawn,
  };
}

// publish as a turn runs it: the call only acknowledges, and the turn's commit reads the answer from its input.
function publishTool(): ToolSet {
  return { [PUBLISH]: tool({ ...PUBLISH_TOOL_DEFINITION[PUBLISH], execute: async () => "Published." }) };
}
