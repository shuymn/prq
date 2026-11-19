// The settings as the store holds them in each state of design/screens.md (Settings), from protocol-checked skills
// and previews with the frames' names, links and commits.

import { Skill, SkillPreview, SkillUpdatePreview } from "@prq/protocol";
import * as v from "valibot";

import { INITIAL, type SettingsState } from "../settings.ts";

const KOPJE = { owner: "shuymn", repo: "kopje" };
const tools = (...entries: string[]) => entries.map((entry) => ({ entry, runs: false }));
const sha = (start: string) => start.padEnd(40, "0");

// 10:02 today, as the frames' "Saved at 10:02".
const at1002 = () => new Date().setHours(10, 2, 0, 0);

export const SKILLS = v.parse(v.array(Skill), [
  {
    name: "review",
    description: "Reviews a pull request diff and lists risky changes.",
    license: null,
    allowedTools: tools("Read", "Grep", "Bash(git diff:*)"),
    rev: 3,
    source: { ...KOPJE, path: "skills/review" },
    ref: { name: "main", kind: "branch" },
    sha: sha("a1b2c3d"),
    registeredAt: 0,
    updatedAt: 0,
  },
  {
    name: "yomiyasu",
    description: "Rewrites Japanese text so that it reads naturally.",
    license: "MIT",
    allowedTools: null,
    rev: 5,
    source: { ...KOPJE, path: "skills/yomiyasu" },
    ref: { name: "v1.2.0", kind: "tag" },
    sha: sha("9f8e7d6"),
    registeredAt: 0,
    updatedAt: 0,
  },
]);

export const REGISTER_PREVIEW = v.parse(SkillPreview, {
  name: "changelog",
  description: "Drafts release notes from the merged pull requests of a repository.",
  license: null,
  allowedTools: tools("Read", "Bash(git log:*)"),
  source: { ...KOPJE, path: "skills/changelog" },
  ref: { name: "main", kind: "branch" },
  sha: sha("c3d4e5f"),
  files: [
    { path: "SKILL.md", size: 2048, mode: "100644", script: false },
    { path: "scripts/draft.sh", size: 512, mode: "100755", script: true },
    { path: "references/format.md", size: 1024, mode: "100644", script: false },
  ],
});

export const UPDATE_PREVIEW = v.parse(SkillUpdatePreview, {
  name: "review",
  description: "Reviews a pull request diff and lists risky changes.",
  license: null,
  allowedTools: tools("Read", "Bash(git diff:*)", "Bash(git log:*)"),
  source: { ...KOPJE, path: "skills/review" },
  ref: { name: "v2", kind: "tag" },
  sha: sha("e4f5a6b"),
  files: [
    { path: "SKILL.md", size: 2048, mode: "100644", script: false },
    { path: "scripts/collect.sh", size: 512, mode: "100755", script: true },
    { path: "references/checklist.md", size: 1024, mode: "100644", script: false },
  ],
  current: {
    source: { ...KOPJE, path: "skills/review" },
    ref: { name: "main", kind: "branch" },
    sha: sha("a1b2c3d"),
    rev: 3,
    allowedTools: tools("Read", "Grep", "Bash(git diff:*)"),
  },
});

const ANALYSIS = "Write in Japanese. Polish the final text with the yomiyasu skill.";
const ANSWER = "Answer in Japanese. Cite file paths and line numbers when you refer to code.";

const clean = (text: string) => ({ draft: text, base: text, status: "idle" as const, savedAt: null });

const READY: SettingsState = {
  ...INITIAL,
  read: "ready",
  skills: SKILLS,
  prompts: { analysis: clean(ANALYSIS), answer: clean(ANSWER) },
};

const REGISTER_URL = "https://github.com/shuymn/kopje/blob/main/skills/changelog/SKILL.md";

export const SETTINGS_STATES: Record<string, () => SettingsState> = {
  default: () => READY,
  empty: () => ({ ...INITIAL, read: "ready" }),
  registering: () => ({
    ...READY,
    dialog: { kind: "register", url: REGISTER_URL, phase: "registering", reason: null },
  }),
  "register-review": () => ({
    ...READY,
    dialog: { kind: "register-review", preview: REGISTER_PREVIEW, busy: false, error: null },
  }),
  "register-failed": () => ({
    ...READY,
    dialog: {
      kind: "register",
      url: REGISTER_URL,
      phase: "failed",
      reason: "No SKILL.md at this link. Check that it points to a SKILL.md file.",
    },
  }),
  saving: () => ({
    ...READY,
    prompts: {
      analysis: { ...clean(ANALYSIS), status: "saving" },
      answer: { ...clean(ANSWER), status: "saved", savedAt: at1002() },
    },
  }),
  "save-failed": () => ({
    ...READY,
    prompts: { analysis: clean(ANALYSIS), answer: { ...clean(ANSWER), status: "failed" } },
  }),
  update: () => ({
    ...READY,
    refForm: { name: "review", ref: "v2", busy: false, error: null },
    dialog: { kind: "update-review", preview: UPDATE_PREVIEW, busy: false, error: null },
  }),
  remove: () => ({ ...READY, dialog: { kind: "remove", name: "review", busy: false, error: null } }),
  // The states the design gives as copy (design/components.md, Feedback): the first read out, failed, and a later
  // read failed.
  loading: () => INITIAL,
  "load-failed": () => ({ ...INITIAL, read: "failed" }),
  "refresh-failed": () => ({ ...READY, refreshFailed: true }),
};
