// Node-side helpers for the e2e suites: they talk to a real `wrangler dev` and run the real prq CLI.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

const SERVER_DIR = fileURLToPath(new URL("../..", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const CLI = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));
const TMP_ROOT = fileURLToPath(new URL("../../../../.tmp", import.meta.url));

// The test values in wrangler.jsonc.
const ACCESS = { secret: "test-access-secret-not-real", aud: "prq-test-aud", iss: "https://test.cloudflareaccess.com" };
export const WEBHOOK_SECRET = "It's a Secret to Everybody";
export const OWNER_ID = 1001;

export async function accessToken(kind: "service" | "user", overrides: { secret?: string } = {}): Promise<string> {
  const claims = kind === "service" ? { common_name: "prq.access" } : { email: "owner@example.com" };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(ACCESS.aud)
    .setIssuer(ACCESS.iss)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(overrides.secret ?? ACCESS.secret));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export type Dev = { url: string; stop(): Promise<void> };

/** Starts `wrangler dev` with fresh local storage and the given var overrides; stop() kills it by PID. */
export async function startDev(vars: Record<string, string> = {}, opts: { config?: string } = {}): Promise<Dev> {
  const port = await freePort();
  const persist = mkdtempSync(join(TMP_ROOT, "persist-"));
  const args = [WRANGLER, "dev", "--port", String(port), "--inspector-port", String(await freePort()), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  if (opts.config) args.push("-c", opts.config);
  // node + wrangler.js directly, detached into its own process group, so stop() can end wrangler and workerd together.
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    env: { ...process.env, TMPDIR: TMP_ROOT, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const stop = async () => {
    if (child.exitCode === null && child.pid) {
      const exited = new Promise((r) => child.once("exit", r));
      process.kill(-child.pid, "SIGTERM");
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    }
    rmSync(persist, { recursive: true, force: true });
  };
  const deadline = Date.now() + 300_000; // the sandbox config builds a Docker image first
  while (!log.includes("Ready on")) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`wrangler dev did not start:\n${log}`);
    }
    await delay(100);
  }
  return { url: `http://127.0.0.1:${port}`, stop };
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type CliResult = { code: number | null; stdout: string; stderr: string; json: any };

/** Runs the real prq CLI (node, type stripping) as a child process, with a deadline. */
export function prq(
  dev: Dev,
  argv: string[],
  opts: { token?: string; agentId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CliResult> & { child: ChildProcess } {
  const child = spawn(process.execPath, [CLI, ...argv], {
    env: {
      ...process.env,
      PRQ_URL: dev.url,
      PRQ_ACCESS_TOKEN: opts.token ?? "",
      ...(opts.agentId ? { PRQ_AGENT_ID: opts.agentId } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
  opts.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  const done = new Promise<CliResult>((resolve) => {
    child.once("exit", (code) => {
      clearTimeout(timer);
      const last = stdout.trim().split("\n").at(-1);
      let json: unknown;
      try {
        json = last ? JSON.parse(last) : undefined;
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
  return Object.assign(done, { child });
}

export async function api(dev: Dev, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${dev.url}${path}`, {
    ...init,
    headers: { "cf-access-jwt-assertion": await accessToken("user"), ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Session names are URL-safe (owner~repo~n), so they go into paths unencoded, as useAgent would send them. */
export function session(name: string): string {
  return name;
}

export async function sessionState(dev: Dev, name: string): Promise<{ owner: string; jobs: any[]; messages: any[] }> {
  return api(dev, `/api/session/${session(name)}`);
}

let delivery = 0;
/** Sends a signed pull_request webhook like GitHub does. */
export async function sendWebhook(
  dev: Dev,
  pr: { repo: string; number: number; headSha: string; authorId?: number; action?: string },
  opts: { deliveryId?: string; secret?: string } = {},
): Promise<Response> {
  const body = JSON.stringify({
    action: pr.action ?? "synchronize",
    pull_request: { number: pr.number, user: { id: pr.authorId ?? OWNER_ID }, head: { sha: pr.headSha } },
    repository: { full_name: pr.repo },
    sender: { id: 9999 },
  });
  const sig = `sha256=${createHmac("sha256", opts.secret ?? WEBHOOK_SECRET).update(body).digest("hex")}`;
  return fetch(`${dev.url}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": opts.deliveryId ?? `d-${Date.now()}-${delivery++}`,
      "x-hub-signature-256": sig,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
}

type Frame = { type: string; [k: string]: any };

/** A chat client speaking the AIChatAgent WebSocket protocol (what useAgentChat does), over Node's WebSocket. */
export class ChatClient {
  messages: any[] = [];
  frames: Frame[] = [];
  #listeners = new Set<() => void>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const frame = JSON.parse(String(ev.data)) as Frame;
      this.frames.push(frame);
      if (frame.type === "cf_agent_chat_messages") this.messages = frame["messages"];
      for (const l of this.#listeners) l();
    });
  }

  static async connect(dev: Dev, name: string, token?: string): Promise<ChatClient> {
    const url = `${dev.url.replace("http", "ws")}/agents/pr-session/${session(name)}`;
    const headers = { "cf-access-jwt-assertion": token ?? (await accessToken("user")) };
    // Node's (undici) WebSocket accepts headers in its init; browsers cannot, they carry the Access cookie instead.
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
      ws.addEventListener("open", () => (clearTimeout(t), resolve()), { once: true });
      ws.addEventListener("error", (e) => (clearTimeout(t), reject(new Error(`ws error ${String((e as ErrorEvent).message)}`))), {
        once: true,
      });
    });
    const client = new ChatClient(ws);
    return client;
  }

  /** Sends a user message like useAgentChat's sendMessage; returns the message ID and the request ID. */
  send(text: string): { messageId: string; requestId: string } {
    const messageId = `u-${crypto.randomUUID()}`;
    const requestId = `r-${crypto.randomUUID().slice(0, 8)}`;
    const message = { id: messageId, role: "user", parts: [{ type: "text", text }] };
    this.messages = [...this.messages, message];
    this.ws.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: requestId,
        init: { method: "POST", body: JSON.stringify({ messages: this.messages, trigger: "submit-message" }) },
      }),
    );
    return { messageId, requestId };
  }

  /** Text streamed for a request (cf_agent_use_chat_response text-delta chunks). */
  streamed(requestId: string): { text: string; done: boolean } {
    let text = "";
    let done = false;
    for (const f of this.frames) {
      if (f.type !== "cf_agent_use_chat_response" || f["id"] !== requestId) continue;
      if (f["done"]) done = true;
      try {
        const chunk = JSON.parse(f["body"] ?? "");
        if (chunk.type === "text-delta") text += chunk.delta;
      } catch {}
    }
    return { text, done };
  }

  async waitFor<T>(check: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
    const hit = check();
    if (hit) return hit;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.#listeners.delete(l);
        reject(new Error(`waitFor timed out; frames: ${this.frames.map((f) => f.type).join(",")}`));
      }, timeoutMs);
      const l = () => {
        const v = check();
        if (v) {
          clearTimeout(t);
          this.#listeners.delete(l);
          resolve(v);
        }
      };
      this.#listeners.add(l);
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((r) => this.ws.addEventListener("close", r, { once: true }));
    this.ws.close();
    await Promise.race([closed, delay(2000)]);
  }
}

export function textOf(m: any): string {
  return (m?.parts ?? []).map((p: any) => (p.type === "text" ? p.text : "")).join("");
}
