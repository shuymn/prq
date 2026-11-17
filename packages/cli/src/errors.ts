// The exit codes the AI's procedure tells apart (docs/design.md, Local CLI): 0 done, 1 anything else, 2 a wait that
// timed out, 3 a setup failure only the host can fix (authentication, or the configuration; restarting cannot fix it),
// 4 a claim mismatch.
export const EXIT = { ok: 0, error: 1, timeout: 2, setup: 3, mismatch: 4 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// A failure that ends the command: its message goes to stderr after `prq: `, and nothing goes to stdout.
export class CliError extends Error {
  override readonly name = "CliError";
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}
