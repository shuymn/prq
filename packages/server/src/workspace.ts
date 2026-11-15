// The cloud workspace: one Container per PrSession, rebuilt from empty at a given commit. Sandbox 1.0 is a Durable
// Object that drives ctx.container itself; @cloudflare/sandbox adds Files (used here for reads).
//
// git traffic leaves the Container only through GitOutbound: the Container has no direct Internet, every HTTP/HTTPS
// request is intercepted, only github.com paths of this session's repo are let through, and the installation token is
// added by the Worker, so it never enters the Container.
import { Files } from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const REPO_DIR = "/workspace/repo";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// exec() does not inherit start()'s environment, so every git command gets the interception CA explicitly.
const GIT_ENV = { GIT_SSL_CAINFO: CA_PATH, GIT_TERMINAL_PROMPT: "0", HOME: "/root" };
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_DEEPEN_STEPS = 8;

export interface WorkspaceEnv {
  Workspace: DurableObjectNamespace<Workspace>;
  /** Stands in for the installation token (github/app.ts); unset in the spike, which only reads a public repo. */
  GITHUB_TOKEN?: string;
}

type OutboundProps = { repo: string };

/** Every outbound request of the Container lands here. */
export class GitOutbound extends WorkerEntrypoint<WorkspaceEnv, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const repoPath = `/${this.ctx.props.repo}`;
    const allowed =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      (url.pathname === `${repoPath}.git` || url.pathname.startsWith(`${repoPath}.git/`) || url.pathname.startsWith(`${repoPath}/`));
    if (!allowed) {
      console.log({ event: "outbound.denied", url: request.url });
      return new Response(`denied: ${url.protocol}//${url.hostname}${url.pathname}\n`, { status: 403 });
    }
    const headers = new Headers(request.headers);
    if (this.env.GITHUB_TOKEN) {
      headers.set("authorization", `Basic ${btoa(`x-access-token:${this.env.GITHUB_TOKEN}`)}`);
    }
    return fetch(new Request(request, { headers }));
  }
}

type ExecResult = { exitCode: number; stdout: string; stderr: string; ms: number };

interface WorkspaceState extends DurableObjectState {
  readonly exports: { GitOutbound: (opts: { props: OutboundProps }) => Fetcher };
}

export class Workspace extends DurableObject<WorkspaceEnv> {
  readonly #ctx: WorkspaceState;

  constructor(ctx: WorkspaceState, env: WorkspaceEnv) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  #container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("Container attachment is unavailable");
    return c;
  }

  /** Starts the Container if needed; returns how long until it ran its first command. */
  async #ensure(repo: string, idleTimeoutMs: number): Promise<{ coldStartMs: number | null }> {
    const c = this.#container();
    if (c.running) return { coldStartMs: null };
    const t0 = Date.now();
    c.start({ image: c.images["sandbox"]!, instance: "lite", enableInternet: false, labels: { app: "prq-spike" } });
    const outbound = this.#ctx.exports.GitOutbound({ props: { repo } });
    await c.interceptAllOutboundHttp(outbound);
    await c.interceptOutboundHttps("*", outbound);
    await c.setInactivityTimeout(idleTimeoutMs);
    await this.exec(["true"]);
    return { coldStartMs: Date.now() - t0 };
  }

  async exec(argv: string[], cwd = "/workspace"): Promise<ExecResult> {
    const t0 = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), COMMAND_TIMEOUT_MS);
    try {
      const p = await this.#container().exec(argv, { cwd, env: GIT_ENV, signal: abort.signal });
      const out = await p.output();
      const d = new TextDecoder();
      return { exitCode: out.exitCode, stdout: d.decode(out.stdout), stderr: d.decode(out.stderr), ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async #git(args: string[]): Promise<ExecResult> {
    const r = await this.exec(["git", "-C", REPO_DIR, ...args]);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr}`);
    return r;
  }

  /**
   * Rebuilds the workspace from empty: git init, shallow fetch of the head and base commits by SHA, checkout of the
   * head; deepens only until a merge-base is found.
   */
  async prepare(input: { repo: string; headSha: string; baseSha: string; idleTimeoutMs?: number }) {
    const { coldStartMs } = await this.#ensure(input.repo, input.idleTimeoutMs ?? 30 * 60_000);
    // Whether a checkout survived from before (it must not after a stop: the Container's disk is gone).
    const leftover = (await this.exec(["test", "-d", REPO_DIR])).exitCode === 0;
    const t0 = Date.now();
    await this.exec(["rm", "-rf", REPO_DIR]);
    await this.exec(["git", "init", "-q", REPO_DIR]);
    await this.#git(["remote", "add", "origin", `https://github.com/${input.repo}.git`]);
    await this.#git(["fetch", "-q", "--depth=1", "--no-tags", "origin", input.headSha, input.baseSha]);
    await this.#git(["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", input.headSha]);
    const fetchMs = Date.now() - t0;
    let deepenSteps = 0;
    let mergeBase = await this.exec(["git", "-C", REPO_DIR, "merge-base", input.headSha, input.baseSha]);
    while (mergeBase.exitCode !== 0 && deepenSteps < MAX_DEEPEN_STEPS) {
      deepenSteps++;
      await this.#git(["fetch", "-q", `--deepen=${2 ** deepenSteps}`, "origin", input.headSha, input.baseSha]);
      mergeBase = await this.exec(["git", "-C", REPO_DIR, "merge-base", input.headSha, input.baseSha]);
    }
    const head = (await this.#git(["rev-parse", "HEAD"])).stdout.trim();
    return {
      leftover,
      head,
      mergeBase: mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : null,
      deepenSteps,
      coldStartMs,
      fetchCheckoutMs: fetchMs,
      rebuildMs: Date.now() - t0,
    };
  }

  async grep(pattern: string): Promise<ExecResult> {
    return this.exec(["git", "-C", REPO_DIR, "grep", "-n", pattern]);
  }

  async read(path: string): Promise<string> {
    const res = await new Files(this.#container()).readFile(`${REPO_DIR}/${path}`);
    return res.text();
  }

  /** Runs a command that tries to leave the allowed path, to show the gateway's deny. */
  async probe(url: string): Promise<ExecResult> {
    return this.exec(["git", "ls-remote", url]);
  }

  async stop(): Promise<void> {
    const c = this.#container();
    if (c.running) await c.destroy();
  }

  async running(): Promise<boolean> {
    return this.#container().running;
  }
}
