import * as v from "valibot";

// The host's instructions (docs/design.md, Instructions and skills): a free-form prompt for the summaries and one for
// the answers, read by every cloud turn of that kind and carried to local agents by /cli/context.

// The longest prompt, in UTF-16 code units. A style prompt is a few lines; the cap bounds the system prompt, the first
// context page and the Hub's row.
export const PROMPT_CHARS = 8000;

// Which prompt: the one an analysis reads, or the one an answer reads.
export const PromptKind = v.picklist(["analysis", "answer"]);
export type PromptKind = v.InferOutput<typeof PromptKind>;

const PromptText = v.pipe(v.string(), v.maxLength(PROMPT_CHARS));

// A prompt as stored: its text (empty when never saved) and when it was saved (epoch ms; null when never saved).
export const Prompt = v.object({ text: PromptText, savedAt: v.nullable(v.number()) });
export type Prompt = v.InferOutput<typeof Prompt>;

export const Prompts = v.object({ analysis: Prompt, answer: Prompt });
export type Prompts = v.InferOutput<typeof Prompts>;

// GET /api/instructions: both prompts, and the registered skills (none can be registered yet).
export const Instructions = v.object({ prompts: Prompts, skills: v.array(v.never()) });
export type Instructions = v.InferOutput<typeof Instructions>;

// PUT /api/prompts/:kind: the prompt's new text, which replaces the stored one. The answer is the stored Prompt.
export const SavePromptRequest = v.object({ text: PromptText });
export type SavePromptRequest = v.InferOutput<typeof SavePromptRequest>;

// What the first /cli/context page carries for a local agent: both prompts, as the settings hold them.
export const ContextInstructions = v.object({ prompts: Prompts });
export type ContextInstructions = v.InferOutput<typeof ContextInstructions>;
