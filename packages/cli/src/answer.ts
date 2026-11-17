import { readFile } from "node:fs/promises";

import { MAX_ANSWER_CHARS } from "@prq/protocol";

import { CliError, EXIT } from "./errors.ts";
import { isMissing } from "./state.ts";

// The answer prq submit sends: answer.md of the claim's directory, as written. A missing, blank or over-long answer
// ends the command before any request.
export async function readAnswer(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new CliError(EXIT.error, `no answer in ${path}: write it there, then run prq submit`);
    }
    throw error;
  }
  return checkAnswer(text, path);
}

// An answer the server accepts: not blank, at most MAX_ANSWER_CHARS UTF-16 code units.
export function checkAnswer(text: string, path: string): string {
  if (text.trim() === "") {
    throw new CliError(EXIT.error, `the answer in ${path} is blank`);
  }
  if (text.length > MAX_ANSWER_CHARS) {
    throw new CliError(
      EXIT.error,
      `the answer in ${path} has ${text.length} characters (UTF-16 code units), more than ${MAX_ANSWER_CHARS}`,
    );
  }
  return text;
}
