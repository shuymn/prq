// The settings' data (plan §1.14): the host's two prompts and registered skills from GET /api/instructions, read when
// the page opens and after each change to the skills, and the writes: a prompt's save, a skill's two-step register and
// update, and its removal. The routes are the server's (docs/design.md, Instructions and skills).
//
// - A prompt's editor keeps the host's draft. A save sends the draft as it is then and leaves typing open; once saved,
//   the editor is clean only if its draft is still the text sent. A read updates an editor only while it is clean.
// - A confirm sends exactly what its preview showed: a register the preview's name, source, ref and SHA; an update the
//   same and the registration's revision the preview was made against. Editing the ref withdraws an update's preview
//   still out. A register answered 409 skill_exists reads the list again: that skill listed at that commit means the
//   registration happened (a resend after a confirm the page stopped waiting for).
// - Every request has a bound past the route's own (each answers within its bound, plus the client's margin), after
//   which it counts as unanswered. Each kind of request has one out at a time: a new one, a closed dialog or the page
//   leaving aborts the one before, and an answer counts only while its request is still the one out.

import {
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
import type { ConfirmError } from "./components/SkillReview.tsx";
import type { Fetch } from "./reads.ts";

// The client's margin past a route's own bound: the route's 503 arrives first, and a missing answer is the network's.
const MARGIN_MS = 15_000;
// A read, a prompt's save and a removal: one call to the Hub.
export const ANSWER_MS = ROUTE_CALL_MS + MARGIN_MS;
// A preview: the registration's revision from the Hub and GitHub's read of the skill (SKILL_PREVIEW_MS, 30 s), in either
// order.
export const PREVIEW_ANSWER_MS = ROUTE_CALL_MS + 30_000 + MARGIN_MS;
// A confirm: an update checks the revision, reads every file (SKILL_FETCH_MS, 60 s), checks again if that failed, and
// stores; a register reads and stores.
export const CONFIRM_ANSWER_MS = 3 * ROUTE_CALL_MS + 60_000 + MARGIN_MS;

export type Editor = {
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
};

const editor = (): Editor => ({ draft: "", base: "", status: "idle", savedAt: null });

export const INITIAL: SettingsState = {
  read: "loading",
  refreshFailed: false,
  skills: [],
  prompts: { analysis: editor(), answer: editor() },
  refForm: null,
  dialog: null,
};

export const PROMPT_TITLES: Record<PromptKind, string> = { analysis: "Analysis prompt", answer: "Answer prompt" };

const SERVER_LINE = "Couldn't reach the server. Try again.";

// A request's answer: its status and body (undefined when it has none it could read), or null when there was none
// within its bound.
type Answer = { status: number; body: unknown } | null;

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

type Kind = "read" | "save:analysis" | "save:answer" | "preview" | "confirm";

export class SettingsStore {
  #state: SettingsState = INITIAL;
  readonly #listeners = new Set<() => void>();
  // The request out for each kind.
  readonly #out = new Map<Kind, AbortController>();
  readonly #fetcher: Fetch;

  constructor(fetcher: Fetch) {
    this.#fetcher = fetcher;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly snapshot = (): SettingsState => this.#state;

  #update(change: Partial<SettingsState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #editor(kind: PromptKind, change: Partial<Editor>): void {
    const prompts = this.#state.prompts;
    this.#update({ prompts: { ...prompts, [kind]: { ...prompts[kind], ...change } } });
  }

  start(): void {
    void this.#read();
  }

  // The page left: every request out is aborted, and its answer counts for nothing.
  stop(): void {
    for (const controller of this.#out.values()) {
      controller.abort();
    }
    this.#out.clear();
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

  // GET /api/instructions: the skills, and each clean editor's prompt. The skills read, or null when it failed or a
  // newer read replaced it.
  async #read(): Promise<Skill[] | null> {
    const answer = await this.#request("read", "/api/instructions", "GET", undefined, ANSWER_MS);
    if (answer === "gone") {
      return null;
    }
    const read = answer?.status === 200 ? v.safeParse(Instructions, answer.body) : null;
    if (read?.success !== true) {
      this.#update(this.#state.read === "ready" ? { refreshFailed: true } : { read: "failed" });
      return null;
    }
    const { prompts, skills } = read.output;
    const clean = (kind: PromptKind): Editor => {
      const current = this.#state.prompts[kind];
      return current.draft === current.base
        ? { ...current, draft: prompts[kind].text, base: prompts[kind].text }
        : current;
    };
    this.#update({
      read: "ready",
      refreshFailed: false,
      skills,
      prompts: { analysis: clean("analysis"), answer: clean("answer") },
    });
    return skills;
  }

  // Try again after a failed read.
  readonly reread = (): void => {
    if (this.#state.read === "failed") {
      this.#update({ read: "loading" });
    }
    void this.#read();
  };

  readonly editPrompt = (kind: PromptKind, text: string): void => {
    this.#editor(kind, { draft: text });
  };

  readonly savePrompt = async (kind: PromptKind): Promise<void> => {
    const text = this.#state.prompts[kind].draft;
    this.#editor(kind, { status: "saving" });
    const answer = await this.#request(`save:${kind}`, `/api/prompts/${kind}`, "PUT", { text }, ANSWER_MS);
    if (answer === "gone") {
      return;
    }
    const saved = answer?.status === 200 ? v.safeParse(Prompt, answer.body) : null;
    if (saved?.success === true) {
      this.#editor(kind, { base: text, status: "saved", savedAt: saved.output.savedAt });
      announce(`${PROMPT_TITLES[kind]} saved.`, "polite");
    } else {
      this.#editor(kind, { status: "failed" });
      announce(`${PROMPT_TITLES[kind]}: save failed.`, "assertive");
    }
  };

  // --- Registering ---

  readonly openRegister = (): void => {
    this.#update({ dialog: { kind: "register", url: "", phase: "idle", reason: null } });
  };

  readonly editUrl = (url: string): void => {
    const dialog = this.#state.dialog;
    if (dialog?.kind === "register") {
      this.#update({ dialog: { ...dialog, url } });
    }
  };

  readonly previewRegister = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "register") {
      return;
    }
    this.#update({ dialog: { ...dialog, phase: "registering", reason: null } });
    const answer = await this.#request(
      "preview",
      "/api/skills/preview",
      "POST",
      { url: dialog.url },
      PREVIEW_ANSWER_MS,
    );
    const current = this.#state.dialog;
    if (answer === "gone" || current?.kind !== "register") {
      return;
    }
    const preview = answer?.status === 200 ? v.safeParse(SkillPreview, answer.body) : null;
    if (preview?.success === true) {
      this.#update({ dialog: { kind: "register-review", preview: preview.output, busy: false, error: null } });
    } else {
      const reason = reasonOf(answer);
      this.#update({ dialog: { ...current, phase: "failed", reason } });
      announce(`Register failed. ${reason}`, "assertive");
    }
  };

  readonly confirmRegister = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "register-review") {
      return;
    }
    const { name, source, ref, sha } = dialog.preview;
    this.#update({ dialog: { ...dialog, busy: true, error: null } });
    const answer = await this.#request("confirm", "/api/skills", "POST", { name, source, ref, sha }, CONFIRM_ANSWER_MS);
    if (answer === "gone") {
      return;
    }
    if (answer !== null && answer.status >= 200 && answer.status < 300) {
      this.#update({ dialog: null });
      void this.#read();
      return;
    }
    let error: ConfirmError = { title: "Couldn't register the skill", text: reasonOf(answer), final: false };
    if (answer?.status === 409 && errorOf(answer)?.error === "skill_exists") {
      // The read is this confirm's last step: closing the dialog meanwhile ends the confirm.
      const confirm = new AbortController();
      this.#out.set("confirm", confirm);
      const skills = await this.#read();
      if (this.#out.get("confirm") !== confirm) {
        return;
      }
      this.#out.delete("confirm");
      if (skills?.some((skill) => samePin(skill, dialog.preview)) === true) {
        this.#update({ dialog: null });
        return;
      }
      if (skills !== null) {
        error = {
          ...error,
          text: `A skill named ${name} is already registered. Remove it first, or cancel.`,
          final: true,
        };
      }
    }
    this.#confirmFailed(error);
  };

  #confirmFailed(error: ConfirmError): void {
    const dialog = this.#state.dialog;
    if (dialog !== null && dialog.kind !== "register") {
      this.#update({ dialog: { ...dialog, busy: false, error } });
      announce(`${error.title}. ${error.text}`, "assertive");
    }
  }

  // --- Updating ---

  readonly openUpdate = (name: string): void => {
    const skill = this.#state.skills.find((candidate) => candidate.name === name);
    if (skill === undefined) {
      return;
    }
    this.#abort("preview");
    this.#update({ refForm: { name, ref: skill.ref.name, busy: false, error: null } });
  };

  // Editing the ref withdraws its preview still out, and the reason the last one was refused.
  readonly editRef = (ref: string): void => {
    const form = this.#state.refForm;
    if (form === null) {
      return;
    }
    this.#abort("preview");
    this.#update({ refForm: { ...form, ref, busy: false, error: null } });
  };

  readonly cancelUpdate = (): void => {
    this.#abort("preview");
    this.#update({ refForm: null });
  };

  readonly previewUpdate = async (): Promise<void> => {
    const form = this.#state.refForm;
    if (form === null) {
      return;
    }
    this.#update({ refForm: { ...form, busy: true, error: null } });
    const path = `/api/skills/${encodeURIComponent(form.name)}/preview`;
    const answer = await this.#request("preview", path, "POST", { ref: form.ref }, PREVIEW_ANSWER_MS);
    const current = this.#state.refForm;
    if (answer === "gone" || current === null) {
      return;
    }
    const preview = answer?.status === 200 ? v.safeParse(SkillUpdatePreview, answer.body) : null;
    if (preview?.success === true) {
      this.#update({
        refForm: { ...current, busy: false },
        dialog: { kind: "update-review", preview: preview.output, busy: false, error: null },
      });
    } else {
      const reason = reasonOf(answer);
      this.#update({ refForm: { ...current, busy: false, error: reason } });
      announce(`Ref: ${reason}`, "assertive");
    }
  };

  readonly confirmUpdate = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "update-review") {
      return;
    }
    const { name, source, ref, sha, current } = dialog.preview;
    this.#update({ dialog: { ...dialog, busy: true, error: null } });
    const body = { name, source, ref, sha, expectedRev: current.rev };
    const answer = await this.#request(
      "confirm",
      `/api/skills/${encodeURIComponent(name)}`,
      "PUT",
      body,
      CONFIRM_ANSWER_MS,
    );
    if (answer === "gone") {
      return;
    }
    if (answer?.status === 200) {
      this.#update({ dialog: null, refForm: null });
      void this.#read();
      return;
    }
    const changed = answer?.status === 409 && errorOf(answer)?.error === "skill_changed";
    if (changed) {
      void this.#read();
    }
    this.#confirmFailed({
      title: "Couldn't apply the update",
      text: changed
        ? "The skill changed since this review. Cancel, then choose Review update for a fresh review."
        : reasonOf(answer),
      final: changed,
    });
  };

  // --- Removing ---

  readonly openRemove = (name: string): void => {
    this.#update({ dialog: { kind: "remove", name, busy: false, error: null } });
  };

  // 204 removed it; 404 says it is gone already. Either way the list is read again.
  readonly confirmRemove = async (): Promise<void> => {
    const dialog = this.#state.dialog;
    if (dialog?.kind !== "remove") {
      return;
    }
    this.#update({ dialog: { ...dialog, busy: true, error: null } });
    const path = `/api/skills/${encodeURIComponent(dialog.name)}`;
    const answer = await this.#request("confirm", path, "DELETE", undefined, ANSWER_MS);
    if (answer === "gone") {
      return;
    }
    if (answer?.status === 204 || answer?.status === 404) {
      this.#update({ dialog: null });
      void this.#read();
      return;
    }
    this.#confirmFailed({ title: "Couldn't remove the skill", text: reasonOf(answer), final: false });
  };

  // The dialog closed (Cancel, Escape): its request out is aborted. A confirm may have reached the server, so the list
  // is read again. An update's review returns to its row's ref form.
  readonly closeDialog = (): void => {
    const dialog = this.#state.dialog;
    if (dialog === null) {
      return;
    }
    this.#abort("preview");
    const confirming = this.#out.has("confirm");
    this.#abort("confirm");
    this.#update({ dialog: null });
    if (confirming) {
      void this.#read();
    }
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
