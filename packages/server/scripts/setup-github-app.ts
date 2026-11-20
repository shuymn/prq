// The setup's GitHub App step: `setup github-app`, or `setup github-app --key <file> --app-id <id>` to adopt an App
// made by hand. What it does, asks and records is docs/operations.md's (Setup 6). The key, the webhook secret, the
// manifest's code and state, the App's OAuth client secret and the installation token are hidden from output, put in no
// argument, and written only to the deploy directory; the client secret is not kept.

import { createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import githubAppJwt from "universal-github-app-jwt";
import * as v from "valibot";

import { fixture } from "./fixture.ts";
import {
  answer,
  answerOf,
  ask,
  askSecret,
  DEPLOY_DIRECTORY,
  hide,
  onInterrupt,
  print,
  privateDirectory,
  readEnvFile,
  readPrivate,
  Refusal,
  TARGET_ENV,
  waitMs,
  WORKER_ENV,
  writePrivate,
} from "./operations.ts";
import { call, duration, gh, sleep } from "./setup-run.ts";
import { readState, recordState } from "./setup-state.ts";
import { KEY_FILE } from "./worker-secrets.ts";

// Only the tests' fixture points these elsewhere or shortens the bounds.
const API = fixture.githubApi ?? "https://api.github.com";
const WEB = fixture.githubWeb ?? "https://github.com";
const openProgram = fixture.open ?? (process.platform === "darwin" ? "open" : "xdg-open");
// GitHub gives the manifest flow an hour, from the form to the code's exchange: the owner gets 55 minutes from the
// moment the form is made, which leaves the exchange its time.
const browserMs = fixture.stepMs ?? 55 * 60_000;
// The wait for the owner to install the App, and between reads of its installations.
const installMs = fixture.followMs ?? 30 * 60_000;
const pollMs = fixture.pollMs ?? 15_000;

// The App's permissions and the event it subscribes to (docs/design.md, Authentication boundary).
const PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
};
const EVENTS = ["pull_request"];
const STATE_KEY = "githubApp";
// How many names past the first (`<login>-prq-2` and on) are tried when GitHub has an App of the name, and the
// longest name GitHub takes: the login is cut to leave room for `-prq` and the longest number.
const NAME_TRIES = 9;
const NAME_LENGTH = 34;
const LOGIN_LENGTH = NAME_LENGTH - "-prq".length - `-${NAME_TRIES + 1}`.length;

type AppValues = { appId: string; key: string };

const Owner = v.object({ login: v.string(), id: v.number(), type: v.optional(v.string()) });
const App = v.object({
  id: v.number(),
  slug: v.optional(v.string()),
  name: v.string(),
  description: v.nullish(v.string()),
  owner: v.nullish(Owner),
  permissions: v.record(v.string(), v.string()),
  events: v.array(v.string()),
});
type App = v.InferOutput<typeof App>;
const Conversion = v.object({
  ...App.entries,
  slug: v.string(),
  pem: v.string(),
  webhook_secret: v.nullish(v.string()),
});
const Installation = v.object({ id: v.number(), account: v.nullish(v.object({ id: v.number(), login: v.string() })) });
const Repositories = v.object({
  total_count: v.number(),
  repositories: v.array(v.object({ full_name: v.string(), private: v.boolean() })),
});
const HookConfig = v.object({ url: v.nullish(v.string()) });
const Token = v.object({ token: v.string() });
const StepState = v.object({
  // A registration started: the name proposed and the nonce its manifest's description carries, by which the App it
  // made is told from any other.
  pending: v.optional(v.object({ name: v.string(), nonce: v.string(), recordedAt: v.string() })),
  testRepository: v.optional(v.string()),
});
type StepRecord = v.InferOutput<typeof StepState>;

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

async function readRecord(): Promise<StepRecord> {
  const found = v.safeParse(StepState, (await readState())[STATE_KEY]);
  return found.success ? found.output : {};
}

async function writeRecord(record: StepRecord): Promise<void> {
  await recordState(STATE_KEY, record);
}

// A REST call to GitHub: its status and JSON (null when it answered none).
async function github(
  path: string,
  { method = "GET", auth }: { method?: string; auth?: string } = {},
): Promise<{ status: number; json: unknown }> {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "prq-setup",
        ...(auth === undefined ? {} : { authorization: `Bearer ${auth}` }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (error) {
    // Only the path's first part: a conversion's path holds the code.
    const what = path.split("/")[1] ?? "";
    const reason = error instanceof Error && error.name === "TimeoutError" ? "no answer in time" : "no connection";
    throw new Refusal(`could not reach GitHub's API (/${what}: ${reason})`);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function shaped<S extends v.GenericSchema>(what: string, schema: S, json: unknown): v.InferOutput<S> {
  const parsed = v.safeParse(schema, json);
  if (!parsed.success) {
    throw new Refusal(`GitHub's ${what} did not answer in the shape this step reads`);
  }
  return parsed.output;
}

async function jwt({ appId, key }: AppValues): Promise<string> {
  try {
    const { token } = await githubAppJwt({ id: Number(appId), privateKey: key });
    return token;
  } catch {
    throw new Refusal(`${KEY_FILE} does not make the App's token (an RSA private key is needed)`);
  }
}

// GET /app with the key's token: the App, or null when GitHub does not take the token as the App's.
async function getApp(values: AppValues): Promise<App | null> {
  const { status, json } = await github("/app", { auth: await jwt(values) });
  if (status === 401 || status === 404) {
    return null;
  }
  if (status !== 200) {
    throw new Refusal(`GitHub answered GET /app with HTTP ${status}`);
  }
  const app = shaped("GET /app", App, json);
  return app.id === Number(values.appId) ? app : null;
}

// gh's account, which the App is made on and whose pull requests the Worker takes.
async function ghUser(): Promise<{ login: string; id: number }> {
  const outcome = await gh(["api", "user"], process.cwd());
  if (outcome.code !== 0) {
    throw new Refusal("gh is not logged in (gh auth login), as the account that opens the pull requests");
  }
  return answerOf("gh api user", Owner, outcome.stdout);
}

// The App GitHub has under a slug, as gh's login reads it; null when there is none.
async function appBySlug(slug: string): Promise<App | null> {
  const outcome = await gh(["api", `apps/${slug}`], process.cwd());
  if (outcome.code === 0) {
    return answerOf(`gh api apps/${slug}`, App, outcome.stdout);
  }
  if (/HTTP 404/.test(outcome.stderr)) {
    return null;
  }
  throw new Refusal(`gh api apps/${slug} failed (exit ${outcome.code ?? "by a signal"})`);
}

// GitHub's slug for an App's name: lowercase, with each run of other characters a hyphen.
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function settingsLink(slug: string): string {
  return `${WEB}/settings/apps/${slug}/advanced`;
}

// Opens a URL in the browser, or says to when the opener fails; the URL is printed either way.
async function openInBrowser(url: string): Promise<void> {
  print(`github-app: opening ${url}`);
  try {
    if ((await call("open", openProgram, [url], process.cwd())).code === 0) {
      return;
    }
  } catch {
    // Said below.
  }
  print(`github-app: could not open a browser: open ${url} yourself`);
}

// The hostname target.env records, or asked and recorded there.
async function hostname(): Promise<string> {
  const recorded = (await readEnvFile(TARGET_ENV))?.get("PRQ_HOST");
  if (recorded !== undefined) {
    if (!HOSTNAME.test(recorded)) {
      throw new Refusal(`${TARGET_ENV} does not set PRQ_HOST to a hostname`);
    }
    return recorded;
  }
  const typed = (await ask("The hostname prq will serve (such as prq.example.com): "))?.trim().toLowerCase() ?? "";
  if (!HOSTNAME.test(typed)) {
    throw new Refusal("that is not a hostname; nothing was written");
  }
  await writePrivate(TARGET_ENV, { PRQ_HOST: typed });
  print(`github-app: wrote PRQ_HOST to ${TARGET_ENV}`);
  return typed;
}

async function keyFile(): Promise<string | null> {
  return (await lstat(join(DEPLOY_DIRECTORY, KEY_FILE)).catch(() => null)) === null ? null : readPrivate(KEY_FILE);
}

// GitHub's key (PKCS#1) as the PKCS#8 the Worker reads; every line hidden from output.
function pkcs8(pem: string): string {
  hide([pem]);
  let key;
  try {
    key = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    throw new Refusal("the App's key is not a private key in PEM");
  }
  hide([key]);
  return key;
}

// The key file and worker.env's names written as one set: the key to a new 0600 file beside its own, worker.env through
// writePrivate (replace: the names the owner agreed to), then the key renamed over its file. A stop between the two
// renames leaves an ID without its key, which GET /app then refuses. The new file is removed on any other ending.
async function writeSet(key: string, values: Record<string, string>, replace: readonly string[]): Promise<void> {
  await privateDirectory({ make: true });
  const temp = join(DEPLOY_DIRECTORY, `.${KEY_FILE}.${randomBytes(6).toString("hex")}`);
  const remove = () => unlink(temp).catch(() => {});
  onInterrupt(remove);
  try {
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const changed = await writePrivate(WORKER_ENV, values, { replace });
    await rename(temp, join(DEPLOY_DIRECTORY, KEY_FILE));
    print(`github-app: wrote ${KEY_FILE}${changed.length > 0 ? ` and ${changed.join(", ")} to ${WORKER_ENV}` : ""}`);
  } finally {
    await remove();
    onInterrupt(null);
  }
}

// The manifest the form posts (GitHub's manifest flow): the webhook inactive until the Worker serves the hostname,
// and the registration's nonce in the description.
function manifest(name: string, nonce: string, host: string, redirect: string): string {
  return JSON.stringify({
    name,
    description: `prq's deployment (registration ${nonce})`,
    url: `https://${host}`,
    hook_attributes: { url: `https://${host}/webhook`, active: false },
    redirect_url: redirect,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: EVENTS,
    request_oauth_on_install: false,
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>prq setup</title><body>${body}</body>`;
}

function sameState(given: string | null, state: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The code from a callback URL this server would take: its own address and path, and the state, before the deadline
// (a later code is not exchanged within GitHub's hour).
function codeOf(url: URL, origin: string, state: string, deadline: number): string | null {
  if (url.origin !== origin || url.pathname !== "/callback" || !sameState(url.searchParams.get("state"), state)) {
    return null;
  }
  if (Date.now() > deadline) {
    return null;
  }
  const code = url.searchParams.get("code");
  if (code === null || !/^[\w-]+$/.test(code)) {
    return null;
  }
  hide([code]);
  return code;
}

// The manifest flow's browser part: the form served on 127.0.0.1, then the code GitHub redirects back with, or the one
// in the URL the owner pastes. The server is closed on every ending.
async function manifestCode(name: string, nonce: string, host: string): Promise<string> {
  const deadline = Date.now() + browserMs;
  const state = randomBytes(32).toString("hex");
  hide([state]);
  const { promise: received, resolve: resolveCode } = Promise.withResolvers<string>();
  let origin = "";
  let form = "";
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(form);
      return;
    }
    if (request.method === "GET" && url.pathname === "/callback") {
      const code = codeOf(url, origin, state, deadline);
      if (code === null) {
        response
          .writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(page("<p>This is not the redirect prq's setup waits for.</p>"));
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(page("<p>GitHub created the App. Return to the terminal.</p>"));
      resolveCode(code);
      return;
    }
    response.writeHead(404).end();
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  onInterrupt(close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject).listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    const action = `${WEB}/settings/apps/new?state=${state}`;
    form = page(
      `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest(name, nonce, host, `${origin}/callback`))}"><p>prq's setup sends GitHub the App's manifest. Keep the name it proposes (${escapeHtml(name)}): a retry finds the App by it.</p><button type="submit">Continue to GitHub</button></form><script>document.forms[0].submit()</script>`,
    );
    await openInBrowser(`${origin}/`);
    print(
      `github-app: on GitHub, keep the name ${name} and click Create GitHub App, within ${duration(deadline - Date.now())}`,
    );
    return await waitForCode(received, origin, state, deadline);
  } finally {
    await close();
    onInterrupt(null);
  }
}

// The code from the redirect, or from a URL pasted at a prompt that does not echo (when the terminal is one), within
// the browser's bound. A pasted URL that is not this server's callback with the state is refused and asked again.
async function waitForCode(
  received: Promise<string>,
  origin: string,
  state: string,
  deadline: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  const abort = new AbortController();
  void received.then(() => abort.abort());
  if (process.stdin.isTTY) {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0 || abort.signal.aborted) {
        break;
      }
      let pasted: string;
      try {
        pasted = await askSecret(
          "If the browser cannot reach this computer, paste its address bar's URL here (not shown): ",
          left,
          abort.signal,
        );
      } catch (error) {
        if (error instanceof Refusal && !abort.signal.aborted && Date.now() < deadline) {
          continue;
        }
        if (error instanceof Refusal) {
          break;
        }
        throw error;
      }
      const url = URL.parse(pasted.trim());
      const code = url === null ? null : codeOf(url, origin, state, deadline);
      if (code !== null) {
        clearTimeout(timer);
        abort.abort();
        return code;
      }
      print(`github-app: that is not the redirect to ${origin}/callback this setup waits for`);
    }
  }
  const code = await Promise.race([received, late]);
  clearTimeout(timer);
  abort.abort();
  if (code === null) {
    throw new Refusal(
      `GitHub did not redirect back within ${duration(browserMs)}: run setup github-app again (an App made meanwhile is found then)`,
    );
  }
  return code;
}

// A name GitHub has no App under: `<login>-prq`, else with a number, within GitHub's length.
async function freeName(login: string): Promise<string> {
  const base = `${login.slice(0, LOGIN_LENGTH)}-prq`;
  for (let n = 1; n <= NAME_TRIES + 1; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if ((await appBySlug(slugOf(name))) === null) {
      return name;
    }
  }
  throw new Refusal(`GitHub has Apps named ${base} to ${base}-${NAME_TRIES + 1}`);
}

// A pending registration, settled before another starts. The App of its name is the one it made only when the
// description carries its nonce: the owner deletes that one. Otherwise the App it may have made cannot be found (a
// changed name, a lost exchange), and the owner looks for it by the nonce and says none is left; nothing else is ever
// named for deletion.
async function settlePending(record: StepRecord): Promise<void> {
  const pending = record.pending;
  if (pending === undefined) {
    return;
  }
  const slug = slugOf(pending.name);
  const found = await appBySlug(slug);
  if (found?.description?.includes(pending.nonce) === true) {
    print(`github-app: the App ${pending.name} was created, but its key did not reach the deploy directory`);
    print(`github-app: delete it (Delete GitHub App, at the bottom): ${settingsLink(slug)}`);
    await ask("Press Enter once it is deleted: ");
    if ((await appBySlug(slug)) !== null) {
      throw new Refusal(`the App ${pending.name} is still there: delete it, then run setup github-app again`);
    }
  } else {
    print(
      `github-app: an earlier registration (${pending.name}) did not finish, and its App, if GitHub made one, is not found`,
    );
    print(
      `github-app: in ${WEB}/settings/apps, delete any App whose description holds "registration ${pending.nonce}"`,
    );
    if (!(await answer("Is no App with that description left? [y/N] "))) {
      throw new Refusal(`the earlier registration is not settled: delete its App, then run setup github-app again`);
    }
  }
  const { pending: _, ...rest } = record;
  await writeRecord(rest);
}

// The App made from the manifest, its values written as one set; the App GitHub answers for them.
async function register(host: string): Promise<AppValues> {
  const user = await ghUser();
  await settlePending(await readRecord());
  const worker = (await readEnvFile(WORKER_ENV)) ?? new Map<string, string>();
  // A new App's set replaces the one recorded whole: its webhook secret too.
  const replace = [
    ...(worker.has("GITHUB_APP_ID") ? ["GITHUB_APP_ID"] : []),
    ...(worker.has("WEBHOOK_SECRET") ? ["WEBHOOK_SECRET"] : []),
    ...(worker.has("HOST_GITHUB_ID") && worker.get("HOST_GITHUB_ID") !== String(user.id) ? ["HOST_GITHUB_ID"] : []),
  ];
  const replaced = [
    ...replace.map((name) => `${name} in ${WORKER_ENV}`),
    ...((await keyFile()) === null ? [] : [KEY_FILE]),
  ];
  if (replaced.length > 0 && !(await answer(`The new App replaces ${replaced.join(" and ")}. Go on? [y/N] `))) {
    throw new Refusal(`kept ${replaced.join(" and ")}; no App was made`);
  }
  const name = await freeName(user.login);
  const nonce = randomBytes(8).toString("hex");
  await writeRecord({ ...(await readRecord()), pending: { name, nonce, recordedAt: new Date().toISOString() } });
  const code = await manifestCode(name, nonce, host);
  const { status, json } = await github(`/app-manifests/${code}/conversions`, { method: "POST" });
  if (status !== 201) {
    throw new Refusal(
      `GitHub did not hand over the App's key (HTTP ${status}): run setup github-app again, which finds the App`,
    );
  }
  if (typeof json === "object" && json !== null) {
    // The answer's secrets, the OAuth client secret among them, which nothing keeps.
    const secrets = ["pem", "webhook_secret", "client_secret"].map((field) => Reflect.get(json, field));
    hide(secrets.filter((value): value is string => typeof value === "string"));
  }
  const made = shaped("manifest conversion", Conversion, json);
  if (made.owner?.id !== user.id) {
    throw new Refusal(
      `GitHub made the App on another account than gh's (${user.login}): delete it at ${settingsLink(made.slug)}, then run setup github-app again with the browser logged in as ${user.login}`,
    );
  }
  const key = pkcs8(made.pem);
  const secret = made.webhook_secret ?? randomBytes(32).toString("hex");
  const values = { appId: String(made.id), key };
  await writeSet(
    key,
    { GITHUB_APP_ID: values.appId, WEBHOOK_SECRET: secret, HOST_GITHUB_ID: String(user.id) },
    replace,
  );
  const { pending: _, ...rest } = await readRecord();
  await writeRecord(rest);
  print(`github-app: created the App ${made.name}`);
  return values;
}

// An App made by hand (docs/operations.md, Setup 6): the downloaded key converted into the deploy directory with its
// ID, checked with GET /app; the download deleted on the owner's yes.
// An App made by hand, checked before anything is written: its key, and that it is gh's account's.
async function adoptable(file: string, appId: string) {
  const info = await lstat(file).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new Refusal(`${file} is not a regular file`);
  }
  const key = pkcs8(await readFile(file, "utf8"));
  const values = { appId, key };
  const app = await getApp(values);
  if (app === null) {
    throw new Refusal(`GitHub does not take ${file} as the key of the App ${appId}`);
  }
  // HOST_GITHUB_ID is gh's account, the one that opens the pull requests: the App must be that account's.
  const user = await ghUser();
  if (app.owner?.id !== user.id) {
    throw new Refusal(
      `the App ${appId} is not ${user.login}'s, the account gh is logged in as: make it on the account that opens the pull requests; nothing was written`,
    );
  }
  return { file, info, key, values, user };
}

async function adopt({ file, info, key, values, user }: Awaited<ReturnType<typeof adoptable>>): Promise<AppValues> {
  const { appId } = values;
  const worker = (await readEnvFile(WORKER_ENV)) ?? new Map<string, string>();
  const stored = await keyFile();
  if (stored !== null && stored !== key && !(await answer(`Replace ${KEY_FILE}? [y/N] `))) {
    throw new Refusal(`kept ${KEY_FILE}; nothing was written`);
  }
  await writeSet(
    key,
    {
      GITHUB_APP_ID: appId,
      // The App's own webhook secret is set from this one when the webhook is turned on.
      WEBHOOK_SECRET: worker.get("WEBHOOK_SECRET") || randomBytes(32).toString("hex"),
      HOST_GITHUB_ID: String(user.id),
    },
    [],
  );
  if (await answer(`Delete ${file}, the key GitHub downloaded (prq's copy is in the deploy directory)? [y/N] `)) {
    const now = await lstat(file).catch(() => null);
    if (now !== null && now.isFile() && now.ino === info.ino && now.dev === info.dev) {
      await unlink(file);
      print(`github-app: deleted ${file}`);
    }
  } else {
    print(`github-app: kept ${file}: delete it once prq's deploy works`);
  }
  return values;
}

// Every page of a list GitHub answers as an array.
async function installations(token: string): Promise<v.InferOutput<typeof Installation>[]> {
  const all: v.InferOutput<typeof Installation>[] = [];
  for (let number = 1; ; number += 1) {
    const { status, json } = await github(`/app/installations?per_page=100&page=${number}`, { auth: token });
    if (status !== 200) {
      throw new Refusal(`GitHub answered GET /app/installations with HTTP ${status}`);
    }
    const listed = shaped("installations", v.array(Installation), json);
    all.push(...listed);
    if (listed.length < 100) {
      return all;
    }
  }
}

// The installation on the account, once the owner made it: its page opened, read every poll within the bound.
async function installation(values: AppValues, slug: string, hostId: number): Promise<number> {
  const find = async () => (await installations(await jwt(values))).find((each) => each.account?.id === hostId);
  let found = await find();
  if (found !== undefined) {
    return found.id;
  }
  await openInBrowser(`${WEB}/apps/${slug}/installations/new`);
  print(
    `github-app: install the App on the repositories you open pull requests in and one small private test repository (waiting up to ${duration(installMs)})`,
  );
  const deadline = Date.now() + installMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    found = await find();
    if (found !== undefined) {
      print("github-app: installed");
      return found.id;
    }
  }
  throw new Refusal(
    `the App was not installed within ${duration(installMs)}: install it, then run setup github-app again`,
  );
}

// The test repository (recorded, else asked) among the installation's repositories, and private.
async function testRepository(values: AppValues, installationId: number): Promise<void> {
  const record = await readRecord();
  const named = record.testRepository ?? (await ask("The private test repository (owner/name): "))?.trim() ?? "";
  if (!REPOSITORY.test(named)) {
    throw new Refusal("that is not owner/name; nothing was recorded");
  }
  const created = await github(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    auth: await jwt(values),
  });
  if (created.status !== 201) {
    throw new Refusal(`GitHub answered the installation token's request with HTTP ${created.status}`);
  }
  const { token } = shaped("installation token", Token, created.json);
  hide([token]);
  let found: { full_name: string; private: boolean } | undefined;
  for (let number = 1, seen = 0; found === undefined; number += 1) {
    const { status, json } = await github(`/installation/repositories?per_page=100&page=${number}`, {
      auth: token,
    });
    if (status !== 200) {
      throw new Refusal(`GitHub answered GET /installation/repositories with HTTP ${status}`);
    }
    const listed = shaped("installation's repositories", Repositories, json);
    found = listed.repositories.find((each) => each.full_name.toLowerCase() === named.toLowerCase());
    seen += listed.repositories.length;
    if (listed.repositories.length === 0 || seen >= listed.total_count) {
      break;
    }
  }
  if (found === undefined) {
    throw new Refusal(
      `the App is not installed on ${named}: add it to the installation, then run setup github-app again`,
    );
  }
  if (!found.private) {
    throw new Refusal(`${named} is public: the test repository is a private one`);
  }
  if (record.testRepository === undefined) {
    await writeRecord({ ...record, testRepository: found.full_name });
  }
  print(`github-app: the test repository ${found.full_name}: installed, private`);
}

// The App as the setup made it: the four read permissions, the pull_request event (or none yet), the owner, and the
// webhook's URL when one is set.
async function readBack(app: App, values: AppValues, host: string, hostId: number, created: boolean): Promise<void> {
  const issues: string[] = [];
  const names = [...new Set([...Object.keys(PERMISSIONS), ...Object.keys(app.permissions)])].toSorted();
  for (const name of names) {
    if (app.permissions[name] !== PERMISSIONS[name]) {
      issues.push(
        `the App's ${name} permission is ${app.permissions[name] ?? "none"}, not ${PERMISSIONS[name] ?? "none"}`,
      );
    }
  }
  const other = app.events.filter((event) => !EVENTS.includes(event));
  if (other.length > 0) {
    issues.push(`the App subscribes to ${other.join(", ")} besides ${EVENTS.join(", ")}`);
  }
  if (app.owner?.id !== hostId) {
    issues.push(`the App's owner is not the account HOST_GITHUB_ID names`);
  }
  const hook = await github("/app/hook/config", { auth: await jwt(values) });
  const url = hook.status === 200 ? (shaped("webhook configuration", HookConfig, hook.json).url ?? "") : "";
  if (hook.status !== 200 && hook.status !== 404) {
    issues.push(`GitHub answered GET /app/hook/config with HTTP ${hook.status}`);
  } else if (url !== "" && url !== `https://${host}/webhook`) {
    issues.push(`the App's webhook URL is ${url}, not https://${host}/webhook`);
  }
  if (issues.length > 0) {
    throw new Refusal(...issues, `fix it in the App's settings: ${settingsLink(app.slug ?? "")}`);
  }
  print(`github-app: permissions ${Object.keys(PERMISSIONS).join(", ")}: read; the owner: HOST_GITHUB_ID's account`);
  print(
    `github-app: events: ${app.events.length === 0 ? "none yet (first-deploy subscribes to Pull request)" : app.events.join(", ")}`,
  );
  print(
    url === ""
      ? "github-app: webhook URL: not set yet (first-deploy sets it)"
      : `github-app: webhook URL: the hostname's /webhook${created ? ", inactive until first-deploy turns it on" : ""}`,
  );
}

type Adopt = { key: string; appId: string };

// `--key <file> --app-id <id>`, in either order, or nothing.
export function adoptArgs(args: readonly string[]): Adopt | null | "invalid" {
  if (args.length === 0) {
    return null;
  }
  if (args.length !== 4) {
    return "invalid";
  }
  const options = new Map([
    [args[0], args[1]],
    [args[2], args[3]],
  ]);
  const key = options.get("--key");
  const appId = options.get("--app-id");
  return key === undefined || appId === undefined || !/^[1-9][0-9]*$/.test(appId) ? "invalid" : { key, appId };
}

export async function githubAppStep(adopted: Adopt | null = null): Promise<void> {
  // A worker.env this step could not write (a name set twice, a stray line) stops it before anything is asked.
  await readEnvFile(WORKER_ENV);
  // An adopted App's owner is checked before the hostname is asked for and written.
  const checked = adopted === null ? null : await adoptable(adopted.key, adopted.appId);
  const host = await hostname();
  let values: AppValues | null = null;
  let app: App | null = null;
  let created = false;
  if (checked !== null) {
    values = await adopt(checked);
  } else {
    const worker = (await readEnvFile(WORKER_ENV)) ?? new Map<string, string>();
    const appId = worker.get("GITHUB_APP_ID");
    const key = await keyFile();
    if (appId !== undefined && (worker.get("WEBHOOK_SECRET") ?? "") !== "" && key !== null) {
      hide([key]);
      app = await getApp({ appId, key });
      if (app !== null) {
        values = { appId, key };
        // A stop after the set was written and before the registration was marked done.
        const { pending, ...rest } = await readRecord();
        if (pending !== undefined) {
          await writeRecord(rest);
        }
        print(`github-app: GitHub takes ${KEY_FILE} as the key of the App GITHUB_APP_ID names`);
      } else if ((await readRecord()).pending === undefined) {
        throw new Refusal(
          `GitHub does not take ${KEY_FILE} as the key of the App GITHUB_APP_ID names: they do not belong together (docs/operations.md, Setup 6)`,
        );
      }
    }
    if (values === null) {
      values = await register(host);
      created = true;
    }
  }
  app ??= await getApp(values);
  if (app === null) {
    throw new Refusal(`GitHub does not take ${KEY_FILE} as the key of the App ${values.appId}`);
  }
  // The App's owner is the account whose pull requests the Worker takes; a stored ID differs only on the owner's yes.
  if (app.owner !== null && app.owner !== undefined) {
    const changed = await writePrivate(WORKER_ENV, { HOST_GITHUB_ID: String(app.owner.id) });
    if (changed.length > 0) {
      print(`github-app: wrote HOST_GITHUB_ID to ${WORKER_ENV}`);
    }
  }
  const hostId = Number((await readEnvFile(WORKER_ENV))?.get("HOST_GITHUB_ID") ?? "");
  const slug = app.slug ?? slugOf(app.name);
  await testRepository(values, await installation(values, slug, hostId));
  await readBack(app, values, host, hostId, created);
  print("github-app: done");
}
