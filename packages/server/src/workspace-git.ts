// The cloud workspace's git procedure as data (docs/design.md, Workspace (cloud)): the argv of every command a checkout
// and a tool run, the decision whether a checkout can be reused, and the order of a prepare's steps. The Workspace runs
// the commands in its container; a Node test runs the same commands with real git against file:// repositories. No
// runtime API here, so both can import it.

// The commit a prepare checks out, the pull request's base it fetches too, and where it fetches from.
export type CheckoutTarget = { remote: string; sha: string; baseSha: string };

// What a prepare does with what it finds (planPrepare).
type PreparePlan = "reuse" | "update" | "rebuild";

// A checkout made ready: its commit, the merge base of the base and the commit when the history reaches it, how the
// prepare made it, and the ready token in its directory (a script run's runner checks it before it starts).
export type Checkout = { sha: string; mergeBase: string | null; plan: PreparePlan; token: string };

// The ready record: what the last complete prepare checked out, and the token it wrote last into the directory. A
// checkout is reused only through it, since a prepare cut short (a stop, a reset) leaves a directory that may look
// complete: HEAD at the commit with a deepen half done.
export type ReadyRecord = CheckoutTarget & { mergeBase: string | null; token: string };

// How one command ended. stdout and stderr are the steps' own short outputs (a SHA, a token, git's message).
export type StepResult = { exitCode: number; stdout: string; stderr: string };

// Runs one command (argv[0] is the program) and reports how it ended; it rejects only when the command could not be
// run or was stopped.
export type StepRunner = (argv: readonly string[]) => Promise<StepResult>;

// Where the ready record is kept: storage outside the checkout, which a container stop does not lose.
export type RecordStore = { read(): ReadyRecord | null; write(record: ReadyRecord): void; clear(): void };

// The file in the checkout that holds the ready record's token: it goes with the disk when the container stops.
export function tokenPath(dir: string): string {
  return `${dir}/.git/prq-ready`;
}

// A stalled transfer ends: git aborts a fetch that moves under 1,000 bytes a second for 60 s.
const FETCH_CONFIG = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];

// The most deepen rounds before the merge base is given up on (doubling: 2 + 4 + … + 256 commits).
const MAX_DEEPEN_ROUNDS = 8;

function git(dir: string, args: readonly string[]): string[] {
  return ["git", "-C", dir, ...args];
}

// A fetch of the commits from origin, as deep as the depth option says.
function fetchOrigin(dir: string, depth: string, shas: readonly string[]): string[] {
  return git(dir, [...FETCH_CONFIG, "fetch", "--quiet", depth, "--no-tags", "--end-of-options", "origin", ...shas]);
}

// The commands of a prepare.
export const prepareArgv = {
  wipe: (dir: string) => ["rm", "-rf", "--", dir],
  init: (dir: string) => ["git", "init", "--quiet", "--", dir],
  remote: (dir: string, remote: string) => git(dir, ["remote", "add", "--", "origin", remote]),
  fetch: (dir: string, shas: readonly string[]) => fetchOrigin(dir, "--depth=1", shas),
  deepen: (dir: string, depth: number, shas: readonly string[]) => fetchOrigin(dir, `--deepen=${depth}`, shas),
  checkout: (dir: string, sha: string) =>
    git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "--end-of-options", sha]),
  mergeBase: (dir: string, sha: string, baseSha: string) => git(dir, ["merge-base", "--end-of-options", sha, baseSha]),
  head: (dir: string) => git(dir, ["rev-parse", "--verify", "HEAD"]),
  readToken: (dir: string) => ["cat", "--", tokenPath(dir)],
  dropToken: (dir: string) => ["rm", "-f", "--", tokenPath(dir)],
  // The token is hex and the path the procedure's own, both passed as arguments, never as shell text.
  // With its own umask: the runtime's for an exec is not guaranteed (Dockerfile).
  writeToken: (dir: string, token: string) => [
    "sh",
    "-c",
    'umask 022; printf %s "$1" > "$2"',
    "sh",
    token,
    tokenPath(dir),
  ],
};

// The git command each tool runs at the workspace commit, as argv after `git` (the Workspace runs it in the checkout).
// Every argument the model gave follows `--end-of-options` or `--`, so none is read as an option.
export const toolArgv = {
  listFiles: (sha: string, path?: string) => ["ls-tree", "-r", "--name-only", "--end-of-options", sha, ...opt(path)],
  readFile: (sha: string, path: string) => ["show", "--end-of-options", `${sha}:${path}`],
  grep: (sha: string, pattern: string, path?: string, ignoreCase?: boolean) => [
    "grep",
    "-n",
    "-I",
    "-E",
    ...(ignoreCase === true ? ["-i"] : []),
    "-e",
    pattern,
    "--end-of-options",
    sha,
    "--",
    ...opt(path),
  ],
  diff: (base: string, sha: string, path?: string) =>
    path === undefined
      ? ["diff", "--numstat", "--end-of-options", base, sha, "--"]
      : ["diff", "--end-of-options", base, sha, "--", path],
};

function opt(path: string | undefined): string[] {
  return path === undefined ? [] : [path];
}

// The command a tool runs in a checkout directory.
export function opArgv(dir: string, argv: readonly string[]): string[] {
  return git(dir, argv);
}

// What a prepare does with what it finds: reuse a checkout of this commit; update a ready checkout of another commit
// in place (its objects kept); or wipe the directory and rebuild from empty. Only a ready record whose token is in the
// directory counts: the record alone survives a stop, the token file does not, and neither is complete before the
// last step of a prepare.
function planPrepare(record: ReadyRecord | null, tokenFile: string | null, target: CheckoutTarget): PreparePlan {
  if (record === null || tokenFile !== record.token || record.remote !== target.remote) {
    return "rebuild";
  }
  return record.sha === target.sha && record.baseSha === target.baseSha ? "reuse" : "update";
}

class PrepareError extends Error {
  override readonly name = "PrepareError";
}

async function must(run: StepRunner, argv: readonly string[], what: string): Promise<StepResult> {
  const result = await run(argv);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim();
    throw new PrepareError(`${what} failed${message === "" ? ` (exit ${result.exitCode})` : `: ${message}`}`);
  }
  return result;
}

// Makes the directory a checkout of the target's commit, through the ready record: reused as it is, updated, or
// rebuilt from empty, then deepened until the merge base answers (at most MAX_DEEPEN_ROUNDS) and checked to have HEAD
// at the commit. Before any change to the directory the record is cleared and the token file removed, and both are
// written as the last steps, the file first, so a prepare cut short at any point leaves no record and the next one
// rebuilds, and a script runner holding the earlier token is refused for the whole prepare and after it. `token` is
// the new record's (random, per prepare).
export async function prepareCheckout(
  run: StepRunner,
  store: RecordStore,
  dir: string,
  target: CheckoutTarget,
  token: string,
): Promise<Checkout> {
  const record = store.read();
  const tokenFile = record === null ? null : await readToken(run, dir);
  const plan = planPrepare(record, tokenFile, target);
  if (plan === "reuse" && record !== null) {
    return { sha: record.sha, mergeBase: record.mergeBase, plan, token: record.token };
  }
  store.clear();
  await must(run, prepareArgv.dropToken(dir), "removing the ready token");
  if (plan === "rebuild") {
    await must(run, prepareArgv.wipe(dir), "clearing the checkout");
    await must(run, prepareArgv.init(dir), "git init");
    await must(run, prepareArgv.remote(dir, target.remote), "adding the remote");
  }
  const shas = [target.sha, target.baseSha];
  await must(run, prepareArgv.fetch(dir, shas), "fetching the commits");
  await must(run, prepareArgv.checkout(dir, target.sha), "checking out the commit");
  let mergeBase = await run(prepareArgv.mergeBase(dir, target.sha, target.baseSha));
  for (let round = 1; mergeBase.exitCode !== 0 && round <= MAX_DEEPEN_ROUNDS; round += 1) {
    await must(run, prepareArgv.deepen(dir, 2 ** round, shas), "deepening the history");
    mergeBase = await run(prepareArgv.mergeBase(dir, target.sha, target.baseSha));
  }
  const head = (await must(run, prepareArgv.head(dir), "reading HEAD")).stdout.trim();
  if (head !== target.sha) {
    throw new PrepareError(`HEAD is ${head}, not the commit ${target.sha}`);
  }
  await must(run, prepareArgv.writeToken(dir, token), "marking the checkout ready");
  const checkout = {
    sha: target.sha,
    mergeBase: mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : null,
    plan,
    token,
  };
  store.write({ ...target, mergeBase: checkout.mergeBase, token });
  return checkout;
}

// The token in the directory, or null when there is none (the file gone with a stopped container's disk).
async function readToken(run: StepRunner, dir: string): Promise<string | null> {
  const result = await run(prepareArgv.readToken(dir));
  return result.exitCode === 0 ? result.stdout : null;
}
