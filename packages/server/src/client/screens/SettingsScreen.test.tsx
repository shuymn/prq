// The settings page over a fetch the test answers (plan P6.1–P6.6): drafts across saves, reads and leaving the page, one
// request per operation, a skill's register, update and removal and what each request sends, a confirm's outcome, the
// dialogs' dismissal and focus, and every request's bound.

import type { Instructions, Skill } from "@prq/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { type Locator, page, userEvent } from "vitest/browser";

import { REGISTER_PREVIEW, SKILLS, UPDATE_PREVIEW } from "../gallery/settings-fixtures.ts";
import { FetchContext } from "../reads.ts";
import { controlledFetch, type Pending } from "../test/fetch.ts";
import { nextTask, until } from "../test/wait.ts";
import SettingsScreen from "./SettingsScreen.tsx";

// Each request's bound (docs/design.md, The settings page): a read, a save or a removal; a preview; a confirm.
const ANSWER_MS = 45_000;
const PREVIEW_ANSWER_MS = 75_000;
const CONFIRM_ANSWER_MS = 165_000;

const textOf = (selector: string) => document.querySelector(selector)?.textContent ?? "";
const instructions = (skills: Skill[], analysis = "", answer = ""): Instructions => ({
  prompts: { analysis: { text: analysis, savedAt: null }, answer: { text: answer, savedAt: null } },
  skills,
});
// A skill of the gallery's fixtures, by name.
function fixture(name: string): Skill {
  const found = SKILLS.find((skill) => skill.name === name);
  if (found === undefined) {
    throw new Error(`no fixture skill named ${name}`);
  }
  return found;
}
const REVIEW = fixture("review");
const YOMIYASU = fixture("yomiyasu");
const CHANGELOG: Skill = { ...REGISTER_PREVIEW, rev: 9, registeredAt: 0, updatedAt: 0 };

// The page over this fetch, as the app opens it.
const openPage = (fetch: ReturnType<typeof controlledFetch>) =>
  render(
    <FetchContext value={fetch.fetch}>
      <SettingsScreen />
    </FetchContext>,
  );

// The page, its first read answered with these instructions (or left out).
async function settings(first: Instructions | null = instructions([REVIEW])) {
  const fetch = controlledFetch();
  const screen = await openPage(fetch);
  if (first !== null) {
    (await fetch.request(0)).respond(first);
    await until(() => document.querySelector("[data-component=PromptEditor]") !== null);
  }
  // The n-th request from now on that matches, once made.
  let seen = fetch.requests.length;
  const next = async (method: string, path: string): Promise<Pending> => {
    const request = await fetch.request(seen);
    seen += 1;
    expect({ method: request.method, path: request.url.pathname }).toEqual({ method, path });
    return request;
  };
  return { fetch, screen, next };
}

const editor = (title: string) => page.getByRole("form", { name: title });
const field = (title: string) => page.getByRole("textbox", { name: title });
// The text in the editor with this title.
const draftOf = (title: string) => {
  const area = field(title).element();
  return area instanceof HTMLTextAreaElement ? area.value : null;
};
const dialog = () => document.querySelector<HTMLDialogElement>("dialog");
const bodyOf = (request: Pending) => JSON.parse(request.body ?? "null") as unknown;
const button = (name: string) => page.getByRole("button", { name, exact: true });

afterEach(() => {
  vi.useRealTimers();
});

// The review skill removed: the read after it, which a save of a prompt can overlap.
async function removeReview(next: Awaited<ReturnType<typeof settings>>["next"]) {
  await userEvent.click(button("Remove"));
  await userEvent.click(button("Remove skill"));
  (await next("DELETE", "/api/skills/review")).respond(null, 204);
  return next("GET", "/api/instructions");
}

describe("the prompts", () => {
  test("a save while the other editor is dirty, and typing while it is out, keep every later draft, through a read too; saving while the PUT is held, Saved at after; a failure offers Save again (P6.1)", async () => {
    const { next } = await settings(instructions([REVIEW], "A0", "B0"));
    await userEvent.fill(field("Answer prompt").element(), "B1");
    await userEvent.fill(field("Analysis prompt").element(), "A1");
    await userEvent.click(editor("Analysis prompt").getByRole("button", { name: "Save prompt" }));
    const save = await next("PUT", "/api/prompts/analysis");
    expect(bodyOf(save)).toEqual({ text: "A1" });
    await expect.element(editor("Analysis prompt").getByText("Saving…")).toBeVisible();
    expect(textOf("[data-component=PromptEditor] [data-component=Button]")).toBe("Save prompt");
    expect(
      document.querySelector("[data-component=PromptEditor] [data-component=Button]")?.getAttribute("data-state"),
    ).toBe("busy");
    await userEvent.fill(field("Analysis prompt").element(), "A2");
    save.respond({ text: "A1", savedAt: new Date().setHours(10, 2, 0, 0) });
    await expect.element(editor("Analysis prompt").getByText("Saved at 10:02")).toBeVisible();
    expect([draftOf("Analysis prompt"), draftOf("Answer prompt")]).toEqual(["A2", "B1"]);

    // A read after a change to the skills: both editors are dirty, so neither takes the stored text.
    await userEvent.click(button("Remove"));
    await userEvent.click(button("Remove skill"));
    (await next("DELETE", "/api/skills/review")).respond(null, 204);
    (await next("GET", "/api/instructions")).respond(instructions([], "A1", "B0"));
    await until(() => dialog() === null && document.querySelector("[data-component=SkillRow]") === null);
    expect([draftOf("Analysis prompt"), draftOf("Answer prompt")]).toEqual(["A2", "B1"]);

    await userEvent.click(editor("Answer prompt").getByRole("button", { name: "Save prompt" }));
    (await next("PUT", "/api/prompts/answer")).fail();
    await expect
      .element(
        editor("Answer prompt").getByText("Save failed: the server did not respond. Your text is kept; save again."),
      )
      .toBeVisible();
    await userEvent.click(editor("Answer prompt").getByRole("button", { name: "Save prompt" }));
    const again = await next("PUT", "/api/prompts/answer");
    expect(bodyOf(again)).toEqual({ text: "B1" });
    again.respond({ text: "B1", savedAt: new Date().setHours(10, 2, 0, 0) });
    await expect.element(editor("Answer prompt").getByText("Saved at 10:02")).toBeVisible();
  });

  test("a read answered while a save is out keeps the later draft, though it is the text read before (M1)", async () => {
    const { next } = await settings(instructions([REVIEW], "A0"));
    await userEvent.fill(field("Analysis prompt").element(), "A1");
    await userEvent.click(editor("Analysis prompt").getByRole("button", { name: "Save prompt" }));
    const save = await next("PUT", "/api/prompts/analysis");
    await userEvent.fill(field("Analysis prompt").element(), "A0");
    (await removeReview(next)).respond(instructions([], "A1"));
    await until(() => document.querySelector("[data-component=SkillRow]") === null);
    expect(draftOf("Analysis prompt")).toBe("A0");
    save.respond({ text: "A1", savedAt: new Date().setHours(10, 2, 0, 0) });
    await expect.element(editor("Analysis prompt").getByText("Saved at 10:02")).toBeVisible();
    expect(draftOf("Analysis prompt")).toBe("A0");
  });

  test("a read that started before a save and is answered after it keeps the saved text (M1)", async () => {
    const { next } = await settings(instructions([REVIEW], "A0"));
    await userEvent.fill(field("Analysis prompt").element(), "A1");
    const read = await removeReview(next);
    await userEvent.click(editor("Analysis prompt").getByRole("button", { name: "Save prompt" }));
    (await next("PUT", "/api/prompts/analysis")).respond({ text: "A1", savedAt: new Date().setHours(10, 2, 0, 0) });
    await expect.element(editor("Analysis prompt").getByText("Saved at 10:02")).toBeVisible();
    read.respond(instructions([], "A0"));
    await until(() => document.querySelector("[data-component=SkillRow]") === null);
    expect(draftOf("Analysis prompt")).toBe("A1");
    await expect.element(editor("Analysis prompt").getByText("Saved at 10:02")).toBeVisible();
  });

  test("leaving the page while a save is out and coming back keeps the later draft; the read on return leaves it, and the save lands (M2)", async () => {
    const { fetch, screen, next } = await settings(instructions([REVIEW], "A0"));
    await userEvent.fill(field("Analysis prompt").element(), "A1");
    await userEvent.click(editor("Analysis prompt").getByRole("button", { name: "Save prompt" }));
    const save = await next("PUT", "/api/prompts/analysis");
    await userEvent.fill(field("Analysis prompt").element(), "A2");
    await screen.unmount();
    expect(save.signal.aborted).toBe(false);

    await openPage(fetch);
    await expect.element(field("Analysis prompt")).toHaveValue("A2");
    (await next("GET", "/api/instructions")).respond(instructions([REVIEW], "A0"));
    await nextTask();
    expect(draftOf("Analysis prompt")).toBe("A2");
    save.respond({ text: "A1", savedAt: new Date().setHours(10, 2, 0, 0) });
    await expect.element(editor("Analysis prompt").getByText("Saved at 10:02")).toBeVisible();
    expect(draftOf("Analysis prompt")).toBe("A2");
  });
});

describe("one request per operation", () => {
  test("Save, Review skill and Review update while their request is out send nothing; typing goes on, and editing a preview's input withdraws it (M3)", async () => {
    const { fetch, next } = await settings(instructions([REVIEW], "A0"));
    const sent = fetch.requests.length;
    const nothingMore = async (count: number) => {
      await nextTask();
      expect(fetch.requests).toHaveLength(count);
    };

    await userEvent.fill(field("Analysis prompt").element(), "A1");
    await userEvent.click(editor("Analysis prompt").getByRole("button", { name: "Save prompt" }));
    const save = await next("PUT", "/api/prompts/analysis");
    await userEvent.fill(field("Analysis prompt").element(), "A2");
    editor("Analysis prompt").getByRole("button", { name: "Save prompt" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await nothingMore(sent + 1);
    save.respond({ text: "A1", savedAt: new Date().setHours(10, 2, 0, 0) });
    await expect.element(editor("Analysis prompt").getByText("Saved at 10:02")).toBeVisible();

    await userEvent.click(button("Update"));
    await userEvent.fill(field("Ref").element(), "v2");
    await userEvent.keyboard("{Enter}");
    const update = await next("POST", "/api/skills/review/preview");
    await userEvent.keyboard("{Enter}");
    await nothingMore(sent + 2);
    await userEvent.fill(field("Ref").element(), "v3");
    expect(update.signal.aborted).toBe(true);
    await userEvent.click(button("Cancel"));

    await userEvent.click(button("Add skill"));
    await userEvent.fill(field("SKILL.md URL").element(), "https://github.com/a/b/blob/main/SKILL.md");
    await userEvent.keyboard("{Enter}");
    const register = await next("POST", "/api/skills/preview");
    await userEvent.keyboard("{Enter}");
    await nothingMore(sent + 3);
    await userEvent.fill(field("SKILL.md URL").element(), "https://github.com/a/b/blob/v2/SKILL.md");
    expect(register.signal.aborted).toBe(true);
  });
});

describe("registering a skill", () => {
  const URL = "https://github.com/shuymn/kopje/blob/main/skills/changelog/SKILL.md";

  async function reviewed() {
    const opened = await settings(instructions([]));
    await userEvent.click(button("Add skill"));
    await userEvent.fill(field("SKILL.md URL").element(), URL);
    await userEvent.click(button("Review skill"));
    const preview = await opened.next("POST", "/api/skills/preview");
    return { ...opened, preview };
  }

  test("is busy while the preview is out; the confirm sends exactly the preview's name, source, ref and SHA; a 409 skill_exists whose read lists that skill at that commit counts as registered (P6.2)", async () => {
    const { preview, next } = await reviewed();
    expect(bodyOf(preview)).toEqual({ url: URL });
    await expect.element(page.getByText("Resolving the ref and fetching the skill…")).toBeVisible();
    expect(document.querySelector("dialog [data-component=Button][type=submit]")?.getAttribute("data-state")).toBe(
      "busy",
    );
    preview.respond(REGISTER_PREVIEW);
    await userEvent.click(button("Register at c3d4e5f"));
    const confirm = await next("POST", "/api/skills");
    const { name, source, ref, sha } = REGISTER_PREVIEW;
    expect(bodyOf(confirm)).toEqual({ name, source, ref, sha });
    confirm.respond({ error: "skill_exists", detail: "a skill named changelog is registered already; update it" }, 409);
    (await next("GET", "/api/instructions")).respond(instructions([CHANGELOG]));
    await until(() => dialog() === null);
    await expect.element(page.getByRole("heading", { name: "changelog" })).toBeVisible();
  });

  test("a 409 skill_exists whose read lists another version shows the name taken, the confirm off", async () => {
    const { preview, next } = await reviewed();
    preview.respond(REGISTER_PREVIEW);
    await userEvent.click(button("Register at c3d4e5f"));
    (await next("POST", "/api/skills")).respond({ error: "skill_exists" }, 409);
    (await next("GET", "/api/instructions")).respond(instructions([{ ...CHANGELOG, sha: "f".repeat(40) }]));
    await expect.element(page.getByText("Couldn't register the skill")).toBeVisible();
    await expect
      .element(page.getByText("A skill named changelog is already registered. Remove it first, or cancel."))
      .toBeVisible();
    await expect.element(button("Register at c3d4e5f")).toBeDisabled();
  });

  test("a refused preview and one that got no answer show Register failed with the reason (settings.register-failed)", async () => {
    const { preview, next } = await reviewed();
    preview.respond({ error: "not_found", detail: "no SKILL.md in shuymn/kopje/skills/changelog at main" }, 404);
    await expect.element(page.getByText("Register failed")).toBeVisible();
    await expect.element(page.getByText("No SKILL.md in shuymn/kopje/skills/changelog at main.")).toBeVisible();
    await userEvent.click(button("Review skill"));
    (await next("POST", "/api/skills/preview")).fail();
    await expect.element(page.getByText("Couldn't reach the server. Try again.")).toBeVisible();
  });
});

// The page with the review skill's ref form open, its ref field focused.
async function refForm() {
  const opened = await settings(instructions([REVIEW]));
  await userEvent.click(button("Update"));
  await expect.element(field("Ref")).toHaveValue("main");
  await expect.element(field("Ref")).toHaveFocus();
  return opened;
}

describe("updating a skill", () => {
  test("editing the ref withdraws its preview; a ref not found and a skill of another name are the field's reason; the confirm applies the preview it reviewed; 409 skill_changed reads again and shows the confirm error (P6.3)", async () => {
    const { next } = await refForm();
    await userEvent.fill(field("Ref").element(), "v2");
    await userEvent.click(button("Review update"));
    const withdrawn = await next("POST", "/api/skills/review/preview");
    expect(bodyOf(withdrawn)).toEqual({ ref: "v2" });
    await userEvent.fill(field("Ref").element(), "v3");
    expect(withdrawn.signal.aborted).toBe(true);
    withdrawn.respond(UPDATE_PREVIEW);
    await nextTask();
    expect(dialog()).toBeNull();

    await userEvent.click(button("Review update"));
    (await next("POST", "/api/skills/review/preview")).respond(
      { error: "not_found", detail: "no branch, tag or commit named v3 in shuymn/kopje" },
      404,
    );
    await expect.element(field("Ref")).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(field("Ref"))
      .toHaveAccessibleDescription(
        "A branch, tag or commit to update to. No branch, tag or commit named v3 in shuymn/kopje.",
      );
    await userEvent.fill(field("Ref").element(), "v2");
    await expect.element(field("Ref")).toHaveAttribute("aria-invalid", "false");
    await userEvent.click(button("Review update"));
    (await next("POST", "/api/skills/review/preview")).respond(
      { error: "invalid_skill", detail: "the skill there is named review-lite, not review" },
      422,
    );
    await expect
      .element(field("Ref"))
      .toHaveAccessibleDescription(
        "A branch, tag or commit to update to. The skill there is named review-lite, not review.",
      );

    await userEvent.click(button("Review update"));
    (await next("POST", "/api/skills/review/preview")).respond(UPDATE_PREVIEW);
    await userEvent.click(button("Apply update to e4f5a6b"));
    const apply = await next("PUT", "/api/skills/review");
    const { name, source, ref, sha } = UPDATE_PREVIEW;
    expect(bodyOf(apply)).toEqual({ name, source, ref, sha, expectedRev: UPDATE_PREVIEW.current.rev });
    apply.respond({ error: "skill_changed" }, 409);
    (await next("GET", "/api/instructions")).respond(instructions([REVIEW]));
    await expect.element(page.getByText("Couldn't apply the update")).toBeVisible();
    await expect
      .element(
        page.getByText("The skill changed since this review. Cancel, then choose Review update for a fresh review."),
      )
      .toBeVisible();
    await expect.element(button("Apply update to e4f5a6b")).toBeDisabled();
  });

  test("the review shows the old and new ref and commit, the tools added and removed, the scripts; Cancel leaves the skill and keeps the ref (P6.4)", async () => {
    const { fetch, next } = await refForm();
    await userEvent.fill(field("Ref").element(), "v2");
    await userEvent.click(button("Review update"));
    (await next("POST", "/api/skills/review/preview")).respond(UPDATE_PREVIEW);
    await until(() => dialog()?.open === true);
    expect(textOf("dialog .pin")).toBe("main a1b2c3d → v2 e4f5a6b");
    expect(
      [...document.querySelectorAll("dialog .tools [data-component=Badge]")].map((badge) => badge.textContent),
    ).toEqual(["Read", "Bash(git diff:*)", "Added: Bash(git log:*)", "Removed: Grep"]);
    expect([...document.querySelectorAll("dialog .files li")].map((file) => file.textContent)).toEqual([
      "SKILL.md",
      "scripts/collect.shscript",
      "references/checklist.md",
    ]);
    const requests = fetch.requests.length;
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Cancel" }));
    await until(() => dialog() === null);
    expect(fetch.requests).toHaveLength(requests);
    await expect.element(field("Ref")).toHaveValue("v2");
    await expect.element(button("Review update")).toBeVisible();
  });
});

describe("a preview's form and input", () => {
  test("Add skill withdraws an update's preview out and its busy state; the late review leaves Add skill and its link (M4)", async () => {
    const { next } = await refForm();
    await userEvent.fill(field("Ref").element(), "v2");
    await userEvent.click(button("Review update"));
    const update = await next("POST", "/api/skills/review/preview");
    await userEvent.click(button("Add skill"));
    expect(update.signal.aborted).toBe(true);
    const URL = "https://github.com/shuymn/kopje/blob/main/skills/changelog/SKILL.md";
    await userEvent.fill(field("SKILL.md URL").element(), URL);
    update.respond(UPDATE_PREVIEW);
    await nextTask();
    await expect.element(page.getByRole("heading", { name: "Add a skill" })).toBeVisible();
    await expect.element(field("SKILL.md URL")).toHaveValue(URL);

    await userEvent.keyboard("{Escape}");
    await until(() => dialog() === null);
    expect(document.querySelector(".ref-form [data-component=Button][type=submit]")?.getAttribute("data-state")).toBe(
      "rest",
    );
    await userEvent.click(button("Review update"));
    expect(bodyOf(await next("POST", "/api/skills/review/preview"))).toEqual({ ref: "v2" });
  });

  test("a register's preview for a link the host has since edited is dropped (M4)", async () => {
    const { next } = await settings(instructions([]));
    await userEvent.click(button("Add skill"));
    await userEvent.fill(field("SKILL.md URL").element(), "https://github.com/a/b/blob/main/SKILL.md");
    await userEvent.click(button("Review skill"));
    const preview = await next("POST", "/api/skills/preview");
    const B = "https://github.com/a/b/blob/v2/SKILL.md";
    await userEvent.fill(field("SKILL.md URL").element(), B);
    expect(preview.signal.aborted).toBe(true);
    preview.respond(REGISTER_PREVIEW);
    await nextTask();
    await expect.element(field("SKILL.md URL")).toHaveValue(B);
    expect(page.getByRole("heading", { name: "changelog" }).elements()).toEqual([]);
    expect(document.querySelector("dialog [data-component=Button][type=submit]")?.getAttribute("data-state")).toBe(
      "rest",
    );
  });
});

describe("a confirm's outcome", () => {
  test("a register's confirm runs on after Escape, and its answer reads the list, which shows the skill (M5)", async () => {
    const { fetch, next } = await settings(instructions([]));
    await userEvent.click(button("Add skill"));
    await userEvent.fill(field("SKILL.md URL").element(), "https://github.com/a/b/blob/main/SKILL.md");
    await userEvent.click(button("Review skill"));
    (await next("POST", "/api/skills/preview")).respond(REGISTER_PREVIEW);
    await userEvent.click(button("Register at c3d4e5f"));
    const confirm = await next("POST", "/api/skills");
    await userEvent.keyboard("{Escape}");
    await until(() => dialog() === null);
    await nextTask();
    expect([confirm.signal.aborted, fetch.requests.length]).toEqual([false, 3]);
    confirm.respond(CHANGELOG, 201);
    (await next("GET", "/api/instructions")).respond(instructions([CHANGELOG]));
    await expect.element(page.getByRole("heading", { name: "changelog" })).toBeVisible();
  });

  test("a closed removal with no outcome whose read fails says it couldn't confirm it, until the next read settles it (M5)", async () => {
    const { next } = await settings(instructions([REVIEW, YOMIYASU]));
    await userEvent.click(
      page.getByRole("listitem").filter({ hasText: "review" }).getByRole("button", { name: "Remove" }),
    );
    await userEvent.click(button("Remove skill"));
    const remove = await next("DELETE", "/api/skills/review");
    await userEvent.keyboard("{Escape}");
    await until(() => dialog() === null);
    remove.respond({ error: "unavailable", detail: "the Hub did not answer in time" }, 503);
    (await next("GET", "/api/instructions")).fail();
    await expect.element(page.getByText("Couldn't confirm that review was removed")).toBeVisible();
    await expect.element(page.getByText("The next read of the list settles it.")).toBeVisible();
    await userEvent.click(button("Try again"));
    (await next("GET", "/api/instructions")).respond(instructions([YOMIYASU]));
    await until(() => document.querySelectorAll("[data-component=SkillRow]").length === 1);
    expect(document.body.textContent).not.toContain("Couldn't confirm");
  });

  test("an update whose answer was lost and whose read failed can't be confirmed; a retry answered 409 whose read lists the reviewed commit is applied (M5)", async () => {
    const { next } = await refForm();
    await userEvent.fill(field("Ref").element(), "v2");
    await userEvent.click(button("Review update"));
    (await next("POST", "/api/skills/review/preview")).respond(UPDATE_PREVIEW);
    await userEvent.click(button("Apply update to e4f5a6b"));
    (await next("PUT", "/api/skills/review")).fail();
    (await next("GET", "/api/instructions")).fail();
    await expect.element(page.getByText("Couldn't confirm the update")).toBeVisible();
    await expect.element(page.getByText("Couldn't reach the server to check. Try again.")).toBeVisible();
    await userEvent.click(button("Apply update to e4f5a6b"));
    (await next("PUT", "/api/skills/review")).respond({ error: "skill_changed" }, 409);
    const { name, source, ref, sha } = UPDATE_PREVIEW;
    (await next("GET", "/api/instructions")).respond(instructions([{ ...REVIEW, name, source, ref, sha, rev: 2 }]));
    await until(() => dialog() === null);
    expect(page.getByRole("textbox", { name: "Ref" }).elements()).toEqual([]);
    expect(textOf("[data-component=SkillRow] .source")).toContain("e4f5a6b");
    expect(document.body.textContent).not.toContain("Couldn't confirm");
  });
});

describe("removing a skill", () => {
  test("focuses Cancel; 204 without a body is removed, and 404 too, each read again (P6.5)", async () => {
    const { next } = await settings(instructions([REVIEW, YOMIYASU]));
    await userEvent.click(
      page.getByRole("listitem").filter({ hasText: "review" }).getByRole("button", { name: "Remove" }),
    );
    await expect.element(page.getByRole("heading", { name: "Remove the skill review?" })).toBeVisible();
    await expect.element(button("Cancel")).toHaveFocus();
    await userEvent.click(button("Remove skill"));
    (await next("DELETE", "/api/skills/review")).respond(null, 204);
    (await next("GET", "/api/instructions")).respond(instructions([YOMIYASU]));
    await until(() => dialog() === null && document.querySelectorAll("[data-component=SkillRow]").length === 1);

    await userEvent.click(button("Remove"));
    await userEvent.click(button("Remove skill"));
    (await next("DELETE", "/api/skills/yomiyasu")).respond({ error: "not_found" }, 404);
    (await next("GET", "/api/instructions")).respond(instructions([]));
    await until(() => dialog() === null);
    await expect.element(page.getByText("No skills registered")).toBeVisible();
  });
});

// A click on the backdrop past the open dialog's corner: the dialog stays open.
async function clickOutside() {
  const open = dialog();
  if (open === null) {
    throw new Error("no dialog is open");
  }
  await userEvent.click(page.elementLocator(open), { position: { x: -40, y: -40 } });
  await nextTask();
  expect(dialog()?.open).toBe(true);
}

describe("the dialogs", () => {
  test("none closes on a click outside it; Escape closes each and returns focus to the control that opened it (P6.6)", async () => {
    const { next } = await settings(instructions([REVIEW]));
    const opens: [string, () => Promise<void>][] = [
      ["Add skill", () => userEvent.click(button("Add skill"))],
      ["Remove", () => userEvent.click(button("Remove"))],
      [
        "Review update",
        async () => {
          await userEvent.click(button("Update"));
          await userEvent.click(button("Review update"));
          (await next("POST", "/api/skills/review/preview")).respond(UPDATE_PREVIEW);
        },
      ],
    ];
    for (const [opener, open] of opens) {
      await open();
      await until(() => dialog()?.open === true);
      await clickOutside();
      await userEvent.keyboard("{Escape}");
      await until(() => dialog() === null);
      await expect.element(button(opener)).toHaveFocus();
    }
  });

  test("an update's review returns focus to the control that asked for it, though focus moved while it was out (LOW 1)", async () => {
    const { next } = await refForm();
    await userEvent.click(button("Review update"));
    const preview = await next("POST", "/api/skills/review/preview");
    await userEvent.click(field("Analysis prompt"));
    preview.respond(UPDATE_PREVIEW);
    await until(() => dialog()?.open === true);
    await userEvent.keyboard("{Escape}");
    await until(() => dialog() === null);
    await expect.element(button("Review update")).toHaveFocus();
  });

  test("closing one ends its preview; leaving the page ends its read and its previews, not a save; a late answer changes nothing", async () => {
    const { screen, next } = await settings(instructions([REVIEW, YOMIYASU]));
    await userEvent.click(button("Add skill"));
    await userEvent.fill(field("SKILL.md URL").element(), "https://github.com/a/b/blob/main/SKILL.md");
    await userEvent.click(button("Review skill"));
    const preview = await next("POST", "/api/skills/preview");
    await userEvent.keyboard("{Escape}");
    await until(() => dialog() === null);
    expect(preview.signal.aborted).toBe(true);
    preview.respond(REGISTER_PREVIEW);
    await nextTask();
    expect(dialog()).toBeNull();

    await userEvent.click(
      page.getByRole("listitem").filter({ hasText: "review" }).getByRole("button", { name: "Remove" }),
    );
    await userEvent.click(button("Remove skill"));
    (await next("DELETE", "/api/skills/review")).respond(null, 204);
    const read = await next("GET", "/api/instructions");
    await userEvent.click(
      page.getByRole("listitem").filter({ hasText: "yomiyasu" }).getByRole("button", { name: "Update" }),
    );
    await userEvent.click(button("Review update"));
    const update = await next("POST", "/api/skills/yomiyasu/preview");
    await userEvent.click(editor("Analysis prompt").getByRole("button", { name: "Save prompt" }));
    const save = await next("PUT", "/api/prompts/analysis");
    await screen.unmount();
    expect([read.signal.aborted, update.signal.aborted, save.signal.aborted]).toEqual([true, true, false]);
  });
});

// Whether the page shows this text.
const shows = (text: string) => () => document.body.textContent.includes(text);

describe("the bounds", () => {
  // Each request: the steps that lead to it, the control that sends it, and what the page shows when it gets no
  // answer. The control is clicked through the DOM: while a userEvent action is out, Vitest moves fake timers on by
  // 50 ms at a time, which would start the bound early.
  type Opened = Awaited<ReturnType<typeof settings>>;
  type Unit = {
    path: string;
    bound: number;
    open?: (next: Opened["next"]) => Promise<void>;
    sends: () => Locator;
    // A confirm's outcome is the read's after it: here its list lacks the change.
    confirm?: true;
    failed: () => boolean;
  };
  const server = shows("Couldn't reach the server. Try again.");
  const units: Record<string, Unit> = {
    "a prompt's save": {
      path: "/api/prompts/analysis",
      bound: ANSWER_MS,
      sends: () => editor("Analysis prompt").getByRole("button", { name: "Save prompt" }),
      failed: shows("Save failed"),
    },
    "a register's preview": {
      path: "/api/skills/preview",
      bound: PREVIEW_ANSWER_MS,
      open: () => userEvent.click(button("Add skill")),
      sends: () => button("Review skill"),
      failed: server,
    },
    "a register's confirm": {
      path: "/api/skills",
      bound: CONFIRM_ANSWER_MS,
      open: async (next) => {
        await userEvent.click(button("Add skill"));
        await userEvent.click(button("Review skill"));
        (await next("POST", "/api/skills/preview")).respond(REGISTER_PREVIEW);
      },
      sends: () => button("Register at c3d4e5f"),
      confirm: true,
      failed: server,
    },
    "an update's preview": {
      path: "/api/skills/review/preview",
      bound: PREVIEW_ANSWER_MS,
      open: () => userEvent.click(button("Update")),
      sends: () => button("Review update"),
      failed: server,
    },
    "an update's confirm": {
      path: "/api/skills/review",
      bound: CONFIRM_ANSWER_MS,
      open: async (next) => {
        await userEvent.click(button("Update"));
        await userEvent.click(button("Review update"));
        (await next("POST", "/api/skills/review/preview")).respond(UPDATE_PREVIEW);
      },
      sends: () => button("Apply update to e4f5a6b"),
      confirm: true,
      failed: server,
    },
    "a removal": {
      path: "/api/skills/review",
      bound: ANSWER_MS,
      open: () => userEvent.click(button("Remove")),
      sends: () => button("Remove skill"),
      confirm: true,
      failed: server,
    },
  };

  test.each(Object.entries(units))(
    "%s gets no answer within its bound, not a tick less, then fails",
    async (_name, unit) => {
      const { fetch, next } = await settings(instructions([REVIEW]));
      await unit.open?.(next);
      await expect.element(unit.sends()).toBeEnabled();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const sender = unit.sends().element();
      if (!(sender instanceof HTMLElement)) {
        throw new Error("the control that sends the request is not an element to click");
      }
      sender.click();
      await until(() => fetch.requests.at(-1)?.url.pathname === unit.path);
      const request = await fetch.request(fetch.requests.length - 1);
      const sent = fetch.requests.length;
      await vi.advanceTimersByTimeAsync(unit.bound - 1);
      expect([unit.failed(), request.signal.aborted]).toEqual([false, false]);
      await vi.advanceTimersByTimeAsync(1);
      expect(request.signal.aborted).toBe(true);
      if (unit.confirm === true) {
        const read = await fetch.request(sent);
        if (read.url.pathname !== "/api/instructions") {
          throw new Error(`the confirm was followed by ${read.method} ${read.url.pathname}, not the list's read`);
        }
        read.respond(instructions([REVIEW]));
      }
      await until(unit.failed);
    },
  );

  test("the first read gets no answer within its bound, not a tick less, then shows the load failure; Try again reads again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch } = await settings(null);
    const read = await fetch.request(0);
    await vi.advanceTimersByTimeAsync(ANSWER_MS - 1);
    expect(document.body.textContent).not.toContain("Couldn't load settings");
    await vi.advanceTimersByTimeAsync(1);
    await until(shows("Couldn't load settings"));
    expect(read.signal.aborted).toBe(true);
    vi.useRealTimers();
    await userEvent.click(button("Try again"));
    (await fetch.request(1)).respond(instructions([REVIEW]));
    await expect.element(page.getByRole("heading", { name: "review" })).toBeVisible();
  });
});
