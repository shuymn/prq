// The settings page's data and requests (docs/design.md, The settings page; the routes: Instructions and skills).

import {
  type ErrorCode,
  ErrorResponse,
  Instructions,
  Prompt,
  type PromptKind,
  ROUTE_CALL_MS,
  type Skill,
  SkillPreview,
  SkillUpdatePreview,
} from "@prq/protocol";
import * as v from "valibot";

import { announce } from "./announce.ts";
import { shortSha } from "./components/Sha.tsx";
import type { ConfirmError } from "./components/SkillReview.tsx";
import type { Fetch } from "./reads.ts";

// The client's margin past a route's own bound: the route's 503 arrives first, and a missing answer is the network's.
const MARGIN_MS = 15_000;
// A read, a prompt's save and a removal: one call to the Hub.
const ANSWER_MS = ROUTE_CALL_MS + MARGIN_MS;
// A preview: the registration's revision from the Hub and GitHub's read of the skill (SKILL_PREVIEW_MS, 30 s), in either
// order.
const PREVIEW_ANSWER_MS = ROUTE_CALL_MS + 30_000 + MARGIN_MS;
// A confirm: an update checks the revision, reads every file (SKILL_FETCH_MS, 60 s), checks again if that failed, and
// stores; a register reads and stores.
const CONFIRM_ANSWER_MS = 3 * ROUTE_CALL_MS + 60_000 + MARGIN_MS;

type Editor = {
  // The host's text, and the text it was read or saved as: it is dirty while they differ.
  draft: string;
  base: string;
  status: "idle" | "saving" | "saved" | "failed";
  savedAt: number | null;
};

export type SettingsDialog =
  | { kind: "register"; url: string; phase: "idle" | "registering" | "failed"; reason: string | null }
  | { kind: "register-review"; preview: SkillPreview; busy: boolean; error: ConfirmError | null }
  | { kind: "update-review"; preview: SkillUpdatePreview; busy: boolean; error: ConfirmError | null }
  | { kind: "remove"; name: string; busy: boolean; error: ConfirmError | null };

// The ref form Update opened under a skill's row: the ref, its preview out, or why the server refused it.
type RefForm = { name: string; ref: string; busy: boolean; error: string | null };

export type SettingsState = {
  // The first read's outcome until one succeeds; a later read that fails keeps what was read, refreshFailed.
  read: "loading" | "failed" | "ready";
  refreshFailed: boolean;
  skills: Skill[];
  prompts: Record<PromptKind, Editor>;
  refForm: RefForm | null;
  dialog: SettingsDialog | null;
  // The confirms whose outcome the page couldn't confirm, once their dialog is closed: what each asked.
  unconfirmed: string[];
};

const editor = (): Editor => ({ draft: "", base: "", status: "idle", savedAt: null });

export const INITIAL: SettingsState = {
  read: "loading",
  refreshFailed: false,
  skills: [],
  prompts: { analysis: editor(), answer: editor() },
  refForm: null,
  dialog: null,
  unconfirmed: [],
};

export const PROMPT_TITLES: Record<PromptKind, string> = { analysis: "Analysis prompt", answer: "Answer prompt" };

const SERVER_LINE = "Couldn't reach the server. Try again.";

// A request's answer: its status and body (undefined when it has none it could read), or null when there was none
// within its bound.
type Answer = { status: number; body: unknown } | null;

// A 200 answer's body as the schema reads it, or null.
function decoded<S extends v.GenericSchema>(answer: Answer, schema: S): v.InferOutput<S> | null {
  if (answer?.status !== 200) {
    return null;
  }
  const read = v.safeParse(schema, answer.body);
  return read.success ? read.output : null;
}

// The server's error body, when the answer is one.
const errorOf = (answer: Answer) => {
  const error = v.safeParse(ErrorResponse, answer?.body);
  return error.success ? error.output : null;
};

// The server's reason, as a sentence ("No branch, tag or commit named v3 in shuymn/kopje."), or the line for a request
// that got no answer, or none the page can read.
function reasonOf(answer: Answer): string {
  const detail = errorOf(answer)?.detail;
  if (detail === undefined || detail === "") {
    return SERVER_LINE;
  }
  const sentence = `${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

// The same skill at the same commit, as a confirm names it.
const samePin = (skill: Skill, preview: SkillPreview) =>
  skill.name === preview.name &&
  skill.sha === preview.sha &&
  skill.ref.name === preview.ref.name &&
  skill.ref.kind === preview.ref.kind &&
  skill.source.owner === preview.source.owner &&
  skill.source.repo === preview.source.repo &&
  skill.source.path === preview.source.path;

// What a confirm asked for, and what the page says of it.
type Change = {
  // The statuses that say it was applied; the conflict a read decides, and the error when the read finds it not
  // applied.
  applied: (status: number) => boolean;
  conflict: { error: ErrorCode; text: string } | null;
  // Whether a list shows it applied.
  listed: (skills: Skill[]) => boolean;
  // The dialog's error title when it was not applied, and the titles for an outcome no read confirmed: the dialog's,
  // and the page's once the dialog is closed.
  failed: string;
  unknown: string;
  notice: string;
};

// A confirm answered with a conflict or without an outcome (no answer, or a 5xx: the route may have stopped waiting
// for a write the Hub still makes), which the first read started after it decides.
type Decision = {
  change: Change;
  answer: Answer;
  conflict: boolean;
  // The dialog it was sent from, the reads started before its answer, and whether a deciding read failed.
  dialog: number;
  after: number;
  unknown: boolean;
};

type Kind = "read" | "save:analysis" | "save:answer" | "preview:register" | "preview:update";

export class SettingsStore {
  #state: SettingsState = INITIAL;
  readonly #listeners = new Set<() => void>();
  // The request out for each kind. A confirm is not one of them: it runs to its answer.
  readonly #out = new Map<Kind, AbortController>();
  readonly #fetcher: Fetch;
  // Each editor's edits and settled saves, counted: a read adopts an editor's text only when none came during it.
  readonly #marks: Record<PromptKind, number> = { analysis: 0, answer: 0 };
  // The reads started, the dialogs opened, and the confirms a read has yet to decide.
  #reads = 0;
  #dialogs = 0;
  readonly #decisions = new Set<Decision>();

  constructor(fetcher: Fetch) {
    this.#fetcher = fetcher;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly snapshot = (): SettingsState => this.#state;

  #update(change: Partial<SettingsState>): void {
    const state = { ...this.#state, ...change };
    const open = state.dialog === null ? null : this.#dialogs;
    const unconfirmed = [...this.#decisions]
      .filter((decision) => decision.unknown && decision.dialog !== open)
      .map((decision) => decision.change.notice);
    this.#state = { ...state, unconfirmed };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #editor(kind: PromptKind, change: Partial<Editor>): void {
    const prompts = this.#state.prompts;
    this.#update({ prompts: { ...prompts, [kind]: { ...prompts[kind], ...change } } });
  }

  // The page left: its read, its previews, its dialog and its ref form end. The drafts, a save and a confirm out stay
  // for the app's life.
  leave(): void {
    this.#abort("read");
    this.#abort("preview:register");
    this.#abort("preview:update");
    this.#update({ dialog: null, refForm: null });
  }

  // A request of this kind, replacing any out; its answer, or "gone" once another replaced it or it was aborted.
  async #request(kind: Kind, url: string, method: string, body: unknown, ms: number): Promise<Answer | "gone"> {
    this.#out.get(kind)?.abort();
    const controller = new AbortController();
    this.#out.set(kind, controller);
    const answer = await send(this.#fetcher, url, method, body, ms, controller.signal);
    if (this.#out.get(kind) !== controller) {
      return "gone";
    }
    this.#out.delete(kind);
    return answer;
  }

  #abort(kind: Kind): void {
    this.#out.get(kind)?.abort();
    this.#out.delete(kind);
  }

  // GET /api/instructions: the skills, and the prompt of each editor that is clean and had no edit or save during the
  // read. It decides the confirms answered before it started.
  async #read(): Promise<void> {
    const read = ++this.#reads;
    const marks = { ...this.#marks };
    const answer = await this.#request("read", "/api/instructions", "GET", undefined, ANSWER_MS);
    if (answer === "gone") {
      return;
    }
    const instructions = decoded(answer, Instructions);
    if (instructions === null) {
      for (const decision of this.#decisions) {
        if (read > decision.after && !decision.unknown) {
          decision.unknown = true;
          this.#unknown(decision);
        }
      }
      this.#update(this.#state.read === "ready" ? { refreshFailed: true } : { read: "failed" });
      return;
    }
    const { prompts, skills } = instructions;
    const adopt = (kind: PromptKind): Editor => {
      const current = this.#state.prompts[kind];
      const untouched = this.#marks[kind] === marks[kind] && !this.#out.has(`save:${kind}`);
      return untouched && current.draft === current.base
        ? { ...current, draft: prompts[kind].text, base: prompts[kind].text }
        : current;
    };
    this.#update({
      read: "ready",
      refreshFailed: false,
      skills,
      prompts: { analysis: adopt("analysis"), answer: adopt("answer") },
    });
    for (const decision of this.#decisions) {
      if (read > decision.after) {
        this.#decisions.delete(decision);
        this.#decide(decision, skills);
      }
    }
  }

  // The page opens, showing what it holds at once, or Try again after a failed read: the saved values are read.
  readonly reread = (): void => {
    if (this.#state.read === "failed") {
      this.#update({ read: "loading" });
    }
    void this.#read();
  };

  readonly editPrompt = (kind: PromptKind, text: string): void => {
    this.#marks[kind] += 1;
    this.#editor(kind, { draft: text });
  };

  // A save while one of the same prompt is out does nothing.
  readonly savePrompt = async (kind: PromptKind): Promise<void> => {
    if (this.#out.has(`save:${kind}`)) {
      return;
    }
    const text = this.#state.prompts[kind].draft;
    this.#editor(kind, { status: "saving" });
    const answer = await this.#request(`save:${kind}`, `/api/prompts/${kind}`, "PUT", { text }, ANSWER_MS);
    if (answer === "gone") {
      return;
    }
    this.#marks[kind] += 1;
    const saved = decoded(answer, Prompt);
    if (saved !== null) {
      this.#editor(kind, { base: text, status: "saved", savedAt: saved.savedAt });
      announce(`${PROMPT_TITLES[kind]} saved.`, "polite");
    } else {
      this.#editor(kind, { status: "failed" });
      announce(`${PROMPT_TITLES[kind]}: save failed.`, "assertive");
    }
  };

  // --- Dialogs and confirms ---

  // Another dialog takes the page: an update's preview still out is withdrawn.
  #openDialog(dialog: SettingsDialog): void {
    this.#withdrawUpdate();
    this.#dialogs += 1;
    this.#update({ dialog });
  }

  // A confirm: it runs to its answer, its dialog open or not, and the list is read after it. A conflict, or an
  // outcome unknown, waits for that read's list.
  async #confirm(change: Change, url: string, method: string, body: unknown, ms: number): Promise<void> {
    const dialog = this.#dialogs;
    const answer = await send(this.#fetcher, url, method, body, ms, new AbortController().signal);
    const conflict = answer?.status === 409 && errorOf(answer)?.error === change.conflict?.error;
    if (answer !== null && change.applied(answer.status)) {
      this.#applied(dialog);
    } else if (answer === null || answer.status >= 500 || conflict) {
      this.#decisions.add({ change, answer, conflict, dialog, after: this.#reads, unknown: false });
    } else {
      this.#confirmFailed(dialog, { title: change.failed, text: reasonOf(answer), final: false });
    }
    void this.#read();
  }

  // A read's list decides a confirm: listed, it was applied; otherwise its dialog says why it was not.
  #decide(decision: Decision, skills: Skill[]): void {
    const { change, answer, dialog } = decision;
    if (change.listed(skills)) {
      this.#applied(dialog);
    } else if (decision.conflict && change.conflict !== null) {
      this.#confirmFailed(dialog, { title: change.failed, text: change.conflict.text, final: true });
    } else {
      this.#confirmFailed(dialog, { title: change.failed, text: reasonOf(answer), final: false });
    }
    this.#update({});
  }

  // A read to decide a confirm failed: its dialog, or the page once that is closed, says so.
  #unknown(decision: Decision): void {
    const error = { title: decision.change.unknown, text: "Couldn't reach the server to check. Try again." };
    if (!this.#confirmFailed(decision.dialog, { ...error, final: false })) {
      announce(`${decision.change.notice}.`, "assertive");
    }
  }

  // The confirm's dialog, while it is open, closes, with an update's ref form.
  #applied(dialog: number): void {
    if (this.#state.dialog !== null && this.#dialogs === dialog) {
      this.#update({
        dialog: null,
        refForm: this.#state.dialog.kind === "update-review" ? null : this.#state.refForm,
      });
    }
  }

  // The confirm's dialog, while it is open, shows the error; whether it did.
  #confirmFailed(dialog: number, error: ConfirmError): boolean {
    const shown = this.#state.dialog;
    if (shown === null || shown.kind === "register" || this.#dialogs !== dialog) {
      return false;
    }
    this.#update({ dialog: { ...shown, busy: false, error } });
    announce(`${error.title}. ${error.text}`, "assertive");
    return true;
  }

  // --- Registering ---

  readonly openRegister = (): void => {
    this.#openDialog({ kind: "register", url: "", phase: "idle", reason: null });
  };

  // Editing the link withdraws its preview still out.
  readonly editUrl = (url: string): void => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "register") {
      return;
    }
    if (dialog.phase === "registering") {
      this.#abort("preview:register");
      this.#update({ dialog: { ...dialog, url, phase: "idle" } });
      return;
    }
    this.#update({ dialog: { ...dialog, url } });
  };

  // A preview while one is out does nothing.
  readonly previewRegister = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "register" || dialog.phase === "registering") {
      return;
    }
    this.#update({ dialog: { ...dialog, phase: "registering", reason: null } });
    const answer = await this.#request(
      "preview:register",
      "/api/skills/preview",
      "POST",
      { url: dialog.url },
      PREVIEW_ANSWER_MS,
    );
    const current = this.#state.dialog;
    if (answer === "gone" || current?.kind !== "register") {
      return;
    }
    const preview = decoded(answer, SkillPreview);
    if (preview !== null) {
      this.#update({ dialog: { kind: "register-review", preview, busy: false, error: null } });
    } else {
      const reason = reasonOf(answer);
      this.#update({ dialog: { ...current, phase: "failed", reason } });
      announce(`Register failed. ${reason}`, "assertive");
    }
  };

  readonly confirmRegister = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "register-review" || dialog.busy) {
      return;
    }
    const { preview } = dialog;
    const { name, source, ref, sha } = preview;
    this.#update({ dialog: { ...dialog, busy: true, error: null } });
    const change: Change = {
      applied: (status) => status >= 200 && status < 300,
      conflict: {
        error: "skill_exists",
        text: `A skill named ${name} is already registered. Remove it first, or cancel.`,
      },
      listed: (skills) => skills.some((skill) => samePin(skill, preview)),
      failed: "Couldn't register the skill",
      unknown: "Couldn't confirm the registration",
      notice: `Couldn't confirm that ${name} was registered`,
    };
    await this.#confirm(change, "/api/skills", "POST", { name, source, ref, sha }, CONFIRM_ANSWER_MS);
  };

  // --- Updating ---

  // The ref form under a skill's row; an update's preview still out is withdrawn.
  readonly openUpdate = (name: string): void => {
    const skill = this.#state.skills.find((candidate) => candidate.name === name);
    if (skill === undefined) {
      return;
    }
    this.#abort("preview:update");
    this.#update({ refForm: { name, ref: skill.ref.name, busy: false, error: null } });
  };

  #withdrawUpdate(): void {
    this.#abort("preview:update");
    const form = this.#state.refForm;
    if (form?.busy === true) {
      this.#update({ refForm: { ...form, busy: false } });
    }
  }

  // Editing the ref withdraws its preview still out, and the reason the last one was refused.
  readonly editRef = (ref: string): void => {
    const form = this.#state.refForm;
    if (form === null) {
      return;
    }
    this.#abort("preview:update");
    this.#update({ refForm: { ...form, ref, busy: false, error: null } });
  };

  readonly cancelUpdate = (): void => {
    this.#abort("preview:update");
    this.#update({ refForm: null });
  };

  // A preview while one is out does nothing.
  readonly previewUpdate = async (): Promise<void> => {
    const form = this.#state.refForm;
    if (form === null || form.busy) {
      return;
    }
    this.#update({ refForm: { ...form, busy: true, error: null } });
    const path = `/api/skills/${encodeURIComponent(form.name)}/preview`;
    const answer = await this.#request("preview:update", path, "POST", { ref: form.ref }, PREVIEW_ANSWER_MS);
    const current = this.#state.refForm;
    if (answer === "gone" || current === null) {
      return;
    }
    const preview = decoded(answer, SkillUpdatePreview);
    if (preview !== null) {
      this.#dialogs += 1;
      this.#update({
        refForm: { ...current, busy: false },
        dialog: { kind: "update-review", preview, busy: false, error: null },
      });
    } else {
      const reason = reasonOf(answer);
      this.#update({ refForm: { ...current, busy: false, error: reason } });
      announce(`Ref: ${reason}`, "assertive");
    }
  };

  readonly confirmUpdate = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "update-review" || dialog.busy) {
      return;
    }
    const { preview } = dialog;
    const { name, source, ref, sha, current } = preview;
    this.#update({ dialog: { ...dialog, busy: true, error: null } });
    const change: Change = {
      applied: (status) => status === 200,
      conflict: {
        error: "skill_changed",
        text: "The skill changed since this review. Cancel, then choose Review update for a fresh review.",
      },
      listed: (skills) => skills.some((skill) => samePin(skill, preview)),
      failed: "Couldn't apply the update",
      unknown: "Couldn't confirm the update",
      notice: `Couldn't confirm that ${name} was updated to ${shortSha(sha)}`,
    };
    const body = { name, source, ref, sha, expectedRev: current.rev };
    await this.#confirm(change, `/api/skills/${encodeURIComponent(name)}`, "PUT", body, CONFIRM_ANSWER_MS);
  };

  // --- Removing ---

  readonly openRemove = (name: string): void => {
    this.#openDialog({ kind: "remove", name, busy: false, error: null });
  };

  // 204 removed it; 404 says it is gone already.
  readonly confirmRemove = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "remove" || dialog.busy) {
      return;
    }
    const { name } = dialog;
    this.#update({ dialog: { ...dialog, busy: true, error: null } });
    const change: Change = {
      applied: (status) => status === 204 || status === 404,
      conflict: null,
      listed: (skills) => !skills.some((skill) => skill.name === name),
      failed: "Couldn't remove the skill",
      unknown: "Couldn't confirm the removal",
      notice: `Couldn't confirm that ${name} was removed`,
    };
    await this.#confirm(change, `/api/skills/${encodeURIComponent(name)}`, "DELETE", undefined, ANSWER_MS);
  };

  // The dialog closed (Cancel, Escape): its preview out is withdrawn; a confirm out runs on. An update's review
  // returns to its row's ref form.
  readonly closeDialog = (): void => {
    if (this.#state.dialog === null) {
      return;
    }
    this.#abort("preview:register");
    this.#update({ dialog: null });
  };
}

// One request with its bound: its answer, or null when it failed or no answer came within `ms`. An abort of `signal`
// ends it too (the caller has stopped waiting). The bound covers the body's read as well.
async function send(
  fetcher: Fetch,
  url: string,
  method: string,
  body: unknown,
  ms: number,
  signal: AbortSignal,
): Promise<Answer> {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), ms);
  const either = AbortSignal.any([signal, bound.signal]);
  const ended = new Promise<never>((_resolve, reject) => {
    either.addEventListener("abort", () => reject(new Error("ended")), { once: true });
  });
  ended.catch(() => undefined);
  try {
    const response = await Promise.race([
      fetcher(url, {
        method,
        credentials: "same-origin",
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        signal: either,
      }),
      ended,
    ]);
    if (response.status === 204) {
      return { status: response.status, body: undefined };
    }
    // A body that is not JSON is an answer without one.
    const read: unknown = await Promise.race([response.json().catch(() => undefined), ended]);
    return { status: response.status, body: read };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The store of each fetch: the app's one fetch keeps its drafts, saves and confirms for the app's life, across leaving
// the page and coming back; a test's fetch has its own.
const stores = new WeakMap<Fetch, SettingsStore>();

export function settingsStore(fetcher: Fetch): SettingsStore {
  let store = stores.get(fetcher);
  if (store === undefined) {
    store = new SettingsStore(fetcher);
    stores.set(fetcher, store);
  }
  return store;
}
