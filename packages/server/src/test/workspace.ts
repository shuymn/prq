// An in-memory workspace for the tool tests and the manual tools check (scripts/tools-check.ts): two revisions of a
// repository, the pull request's base and head, held as files. It answers the git commands the tools run (and only
// those, so a test also pins their argv) with the output git gives, and reads it through the same page reader as the
// Sandbox, emitted in chunks. No vitest here: the manual check imports it too.

import { pageLines } from "../pr-session/pages.ts";
import {
  type CommandResult,
  type PreparedWorkspace,
  STDERR_CHARS,
  type WorkspaceClient,
  type WorkspaceCommand,
  type WorkspaceTarget,
} from "../pr-session/workspace.ts";

// A revision's files by path; a file is text, or bytes for a binary one.
export type Files = Record<string, string | Uint8Array>;

type Output = { exitCode: number; stdout: Uint8Array; stderr: string };

const encoder = new TextEncoder();

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

function textOf(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

// git's test for a binary file: a NUL among the first 8,000 bytes.
function isBinary(content: string | Uint8Array): boolean {
  return bytesOf(content).subarray(0, 8000).includes(0);
}

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function ok(text: string): Output {
  return { exitCode: 0, stdout: encoder.encode(text), stderr: "" };
}

function fatal(message: string): Output {
  return { exitCode: 128, stdout: new Uint8Array(), stderr: `fatal: ${message}\n` };
}

function joinLines(list: readonly string[]): string {
  return list.map((line) => `${line}\n`).join("");
}

// Whether a pathspec (a file or a directory, as git ls-tree, grep and diff read one) covers a path.
function covers(spec: string | undefined, path: string): boolean {
  if (spec === undefined || spec === "." || spec === "") {
    return true;
  }
  const dir = spec.endsWith("/") ? spec : `${spec}/`;
  return path === spec || path.startsWith(dir);
}

type Edit = { kind: " " | "-" | "+"; text: string };

// A line diff by the longest common subsequence: small files only, which is what tests and the manual check have.
function lineEdits(before: string[], after: string[]): Edit[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        before[i] === after[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      edits.push({ kind: " ", text: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if (
      i < before.length &&
      (j === after.length || (table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0))
    ) {
      // A removal before an addition, as git prints them.
      edits.push({ kind: "-", text: before[i] ?? "" });
      i += 1;
    } else {
      edits.push({ kind: "+", text: after[j] ?? "" });
      j += 1;
    }
  }
  return edits;
}

const CONTEXT_LINES = 3;

// A file's patch as git diff prints it: headers, then hunks with three lines of context.
function patch(path: string, before: string | undefined, after: string | undefined): string {
  const out = [`diff --git a/${path} b/${path}`];
  if (before === undefined) {
    out.push("new file mode 100644");
  } else if (after === undefined) {
    out.push("deleted file mode 100644");
  }
  if ((before !== undefined && isBinary(before)) || (after !== undefined && isBinary(after))) {
    out.push(
      `Binary files ${before === undefined ? "/dev/null" : `a/${path}`} and ${after === undefined ? "/dev/null" : `b/${path}`} differ`,
    );
    return joinLines(out);
  }
  out.push(
    before === undefined ? "--- /dev/null" : `--- a/${path}`,
    after === undefined ? "+++ /dev/null" : `+++ b/${path}`,
  );
  const edits = lineEdits(splitLines(before ?? ""), splitLines(after ?? ""));
  // Hunks: changes closer than twice the context apart share one, with three lines of context around it.
  const changes = edits.flatMap((edit, index) => (edit.kind === " " ? [] : [index]));
  const groups: [number, number][] = [];
  for (const index of changes) {
    const last = groups.at(-1);
    if (last !== undefined && index - last[1] - 1 <= 2 * CONTEXT_LINES) {
      last[1] = index;
    } else {
      groups.push([index, index]);
    }
  }
  for (const [first, last] of groups) {
    const from = Math.max(0, first - CONTEXT_LINES);
    const to = Math.min(edits.length, last + CONTEXT_LINES + 1);
    const preceding = edits.slice(0, from);
    const hunk = edits.slice(from, to);
    const oldCount = hunk.filter((edit) => edit.kind !== "+").length;
    const newCount = hunk.filter((edit) => edit.kind !== "-").length;
    const oldStart = preceding.filter((edit) => edit.kind !== "+").length + (oldCount === 0 ? 0 : 1);
    const newStart = preceding.filter((edit) => edit.kind !== "-").length + (newCount === 0 ? 0 : 1);
    out.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...hunk.map((edit) => `${edit.kind}${edit.text}`),
    );
  }
  return joinLines(out);
}

export type FakeWorkspaceOptions = {
  base?: Files;
  head?: Files;
  // Whether the checkout's history reaches the merge base (the base revision), as a deepened fetch would.
  mergeBase?: boolean;
  // The size of the chunks the output is emitted in.
  chunkBytes?: number;
};

export class FakeWorkspace implements WorkspaceClient {
  readonly prepares: WorkspaceTarget[] = [];
  readonly commands: (WorkspaceCommand & { target: WorkspaceTarget })[] = [];
  // The sequences released, in order.
  readonly releases: number[] = [];
  // A prepare that fails with this error, or never settles; a run that never settles.
  prepareFailure: Error | null = null;
  prepareHangs = false;
  hang = false;
  readonly #base: Files;
  readonly #head: Files;
  readonly #mergeBase: boolean;
  readonly #chunkBytes: number;
  #target: WorkspaceTarget | null = null;

  constructor({ base = {}, head = {}, mergeBase = true, chunkBytes = 4096 }: FakeWorkspaceOptions = {}) {
    this.#base = base;
    this.#head = head;
    this.#mergeBase = mergeBase;
    this.#chunkBytes = chunkBytes;
  }

  async prepare(target: WorkspaceTarget, _signal: AbortSignal): Promise<PreparedWorkspace> {
    this.prepares.push(target);
    if (this.prepareHangs) {
      return new Promise<never>(() => undefined);
    }
    if (this.prepareFailure !== null) {
      throw this.prepareFailure;
    }
    this.#target = target;
    return { sha: target.sha, mergeBase: this.#mergeBase ? target.baseSha : null };
  }

  async run(target: WorkspaceTarget, command: WorkspaceCommand, _signal: AbortSignal): Promise<CommandResult> {
    this.commands.push({ ...command, target });
    if (this.hang) {
      return new Promise<never>(() => undefined);
    }
    if (this.#target?.sha !== target.sha || this.#target.baseSha !== target.baseSha) {
      throw new Error("a command for a commit that was not prepared");
    }
    const output = this.#git(command.argv);
    const page = await pageLines(this.#stream(output.stdout), command.page);
    return { exitCode: output.exitCode, page, stderr: output.stderr.slice(0, STDERR_CHARS) };
  }

  async release(seq: number): Promise<void> {
    this.releases.push(seq);
  }

  #stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + this.#chunkBytes));
        offset += this.#chunkBytes;
      },
    });
  }

  #revision(sha: string | undefined): Files | null {
    if (sha === this.#target?.sha) {
      return this.#head;
    }
    return sha === this.#target?.baseSha ? this.#base : null;
  }

  #git(argv: readonly string[]): Output {
    const [command, ...args] = argv;
    switch (command) {
      case "ls-tree":
        return this.#lsTree(args);
      case "show":
        return this.#show(args);
      case "grep":
        return this.#grep(args);
      case "diff":
        return this.#diff(args);
      default:
        throw new Error(`a git command the tools do not run: ${argv.join(" ")}`);
    }
  }

  #lsTree(args: string[]): Output {
    const [r, nameOnly, end, sha, path, ...more] = args;
    if (r !== "-r" || nameOnly !== "--name-only" || end !== "--end-of-options" || more.length > 0) {
      throw new Error(`ls-tree argv: ${args.join(" ")}`);
    }
    const files = this.#revision(sha);
    if (files === null) {
      return fatal("Not a valid object name");
    }
    return ok(
      joinLines(
        Object.keys(files)
          .filter((name) => covers(path, name))
          .toSorted(),
      ),
    );
  }

  #show(args: string[]): Output {
    const [end, spec, ...more] = args;
    if (end !== "--end-of-options" || spec === undefined || more.length > 0) {
      throw new Error(`show argv: ${args.join(" ")}`);
    }
    const colon = spec.indexOf(":");
    const sha = spec.slice(0, colon);
    const path = spec.slice(colon + 1);
    const files = this.#revision(sha);
    if (files === null) {
      return fatal(`invalid object name '${sha}'.`);
    }
    const content = files[path];
    if (content !== undefined) {
      return { exitCode: 0, stdout: bytesOf(content), stderr: "" };
    }
    const dir = path.endsWith("/") ? path : `${path}/`;
    const entries = new Set(
      Object.keys(files)
        .filter((name) => name.startsWith(dir))
        .map((name) => {
          const rest = name.slice(dir.length);
          const slash = rest.indexOf("/");
          return slash === -1 ? rest : rest.slice(0, slash + 1);
        }),
    );
    if (entries.size > 0) {
      return ok(`tree ${spec}\n\n${joinLines([...entries].toSorted())}`);
    }
    return fatal(`path '${path}' does not exist in '${sha}'`);
  }

  #grep(args: string[]): Output {
    let index = 0;
    const flags = new Set<string>();
    while (args[index] !== "-e") {
      const flag = args[index];
      if (flag === undefined || !["-n", "-I", "-E", "-i"].includes(flag)) {
        throw new Error(`grep argv: ${args.join(" ")}`);
      }
      flags.add(flag);
      index += 1;
    }
    const [, pattern = "", end, sha, separator, path, ...more] = args.slice(index);
    if (
      !flags.has("-n") ||
      !flags.has("-I") ||
      !flags.has("-E") ||
      end !== "--end-of-options" ||
      separator !== "--" ||
      more.length > 0
    ) {
      throw new Error(`grep argv: ${args.join(" ")}`);
    }
    const files = this.#revision(sha);
    if (files === null) {
      return fatal(`unable to resolve revision: ${sha}`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags.has("-i") ? "i" : "");
    } catch (error) {
      return fatal(`-e option, '${pattern}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const matches: string[] = [];
    for (const name of Object.keys(files).toSorted()) {
      const content = files[name];
      if (content === undefined || !covers(path, name) || isBinary(content)) {
        continue;
      }
      for (const [number, line] of splitLines(textOf(content)).entries()) {
        if (regex.test(line)) {
          matches.push(`${sha}:${name}:${number + 1}:${line}`);
        }
      }
    }
    return matches.length === 0 ? { exitCode: 1, stdout: new Uint8Array(), stderr: "" } : ok(joinLines(matches));
  }

  #diff(args: string[]): Output {
    const numstat = args[0] === "--numstat";
    const [end, base, sha, separator, path, ...more] = numstat ? args.slice(1) : args;
    if (end !== "--end-of-options" || separator !== "--" || more.length > 0 || (numstat && path !== undefined)) {
      throw new Error(`diff argv: ${args.join(" ")}`);
    }
    const before = this.#revision(base);
    const after = this.#revision(sha);
    if (before === null || after === null) {
      return fatal("bad revision");
    }
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((name) => covers(path, name))
      .filter((name) => {
        const [a, b] = [before[name], after[name]];
        return a === undefined || b === undefined || textOf(a) !== textOf(b);
      })
      .toSorted();
    if (!numstat) {
      return ok(changed.map((name) => patch(name, toText(before[name]), toText(after[name]))).join(""));
    }
    return ok(
      joinLines(
        changed.map((name) => {
          const [a, b] = [before[name], after[name]];
          if ((a !== undefined && isBinary(a)) || (b !== undefined && isBinary(b))) {
            return `-\t-\t${name}`;
          }
          const edits = lineEdits(splitLines(toText(a) ?? ""), splitLines(toText(b) ?? ""));
          const added = edits.filter((edit) => edit.kind === "+").length;
          const removed = edits.filter((edit) => edit.kind === "-").length;
          return `${added}\t${removed}\t${name}`;
        }),
      ),
    );
  }
}

function toText(content: string | Uint8Array | undefined): string | undefined {
  return content === undefined ? undefined : textOf(content);
}
