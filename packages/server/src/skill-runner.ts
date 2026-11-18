import { createTar } from "nanotar";

// The container's skill runner (container/prq-skill-run.py) as data (docs/design.md, Workspace (cloud)): the argv the
// Workspace executes, the frame it writes to the runner's stdin, and the trailer the runner ends its stderr with. No
// runtime API here, so the Workspace and the runner's Node test both import it.

// Where the image installs the runner, root-owned.
const RUNNER_PATH = "/usr/local/libexec/prq-skill-run";
const RUNNER = ["python3", "-I", "-S", RUNNER_PATH];
// The root the runner keeps its state, the scratch and the skills under; the checkout is its repo/.
export const RUNNER_ROOT = "/workspace";
// The user scripts run as.
const SCRIPT_USER = "skill";

// The exec of one script run: the runner with the skill's name and the script's validated argv.
export function runnerArgv(name: string, argv: readonly string[]): string[] {
  return [...RUNNER, "--root", RUNNER_ROOT, "--user", SCRIPT_USER, name, "--", ...argv];
}

// The cleanup after a reset: root's git, git-*, rm, cat and sh processes, each checked through a pidfd before it is
// signalled. It exits 0 when it killed one, 1 when none, and 2 when it could not look (no pidfd), on which the
// Workspace stops the container.
export const RESET_CLEANUP_ARGV = [...RUNNER, "--reset-cleanup"];

// What a frame's header says: the run's nonce (which only the runner reads, so only its trailer carries it), the
// turn's sequence, its scratch generation and whether the scratch is new, the checkout's ready token, and the time
// left on the call's bound.
export type FrameHeader = { nonce: string; seq: number; gen: number; first: boolean; token: string; leftMs: number };

// A file of the skill as the archive holds it.
export type FrameFile = { path: string; mode: "100644" | "100755"; content: Uint8Array };

// The frame of a run, in the order it is written: the header line (with the sizes of the two sections that follow),
// a tar archive of the skill's files with their modes (every path at most 100 bytes, the ustar name field), and the
// script's input.
export function scriptFrame(header: FrameHeader, files: readonly FrameFile[], input: Uint8Array): Uint8Array[] {
  const archive = createTar(
    files.map((file) => ({
      name: file.path,
      data: file.content,
      attrs: { mode: file.mode === "100755" ? "755" : "644", uid: 0, gid: 0, mtime: 0, user: "root", group: "root" },
    })),
  );
  const line = JSON.stringify({ ...header, archiveBytes: archive.byteLength, inputBytes: input.byteLength });
  return [new TextEncoder().encode(`${line}\n`), archive, input];
}

// How a run ended, as its trailer says.
export type RunnerEnd =
  | { kind: "exit"; code: number }
  | { kind: "timeout" }
  | { kind: "busy" }
  | { kind: "failed"; reason: string; detail: string | null };

export type Trailer = { scratch: "new" | "kept" | "lost" | null; end: RunnerEnd; clean: boolean };

const TRAILER =
  /^([0-9a-f]+|-) scratch=(new|kept|lost|-) end=(?:exit:(0|[1-9][0-9]{0,2})|(timeout)|(busy)|failed:([a-z-]+)(?: (.*))?) clean=([01])$/;

// The longest trailer line: the nonce and the fields, with a refused member's path (300 characters at most).
const TRAILER_CHARS = 600;

// The script's stderr and the run's trailer, from the end of the runner's stderr: the trailer is its last line, after
// a newline the runner writes before it, and counts only when it carries this run's nonce. The newline and the trailer
// are taken off, so the script's stderr is returned as written, a last line without a newline included.
export function splitTrailer(stderr: string, nonce: string): { stderr: string; trailer: Trailer | null } {
  const body = stderr.endsWith("\n") ? stderr.slice(0, -1) : stderr;
  const start = body.lastIndexOf("\n");
  const match = TRAILER.exec(body.slice(start + 1));
  if (start === -1 || match === null || match[1] !== nonce) {
    return { stderr, trailer: null };
  }
  const [, , scratch, code, timeout, busy, reason, detail, clean] = match;
  const end: RunnerEnd =
    code !== undefined
      ? { kind: "exit", code: Number(code) }
      : timeout !== undefined
        ? { kind: "timeout" }
        : busy !== undefined
          ? { kind: "busy" }
          : { kind: "failed", reason: reason ?? "", detail: detail ?? null };
  return {
    stderr: body.slice(0, start),
    trailer: {
      scratch: scratch === "new" || scratch === "kept" || scratch === "lost" ? scratch : null,
      end,
      clean: clean === "1",
    },
  };
}

// What of the runner's stderr is kept: the script's tail and room for the trailer line after it.
export function stderrKept(tailChars: number): number {
  return tailChars + TRAILER_CHARS;
}
