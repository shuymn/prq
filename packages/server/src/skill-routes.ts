import { vValidator } from "@hono/valibot-validator";
import {
  type ErrorResponse,
  PreviewSkillRequest,
  PreviewUpdateRequest,
  RegisterSkillRequest,
  type Skill,
  SkillName,
  type SkillUpdatePreview,
  UpdateSkillRequest,
} from "@prq/protocol";
import { type Context, Hono } from "hono";
import * as v from "valibot";

import { readGithubAppConfig } from "./config.ts";
import { type GithubClient, githubFor } from "./github.ts";
import { type CallBound, errorResponse, hubCall, invalidRequest } from "./http.ts";
import { fetchSkill, previewSkill, SkillFailure } from "./instructions/fetch.ts";
import { parseSkillLink, type SkillLink } from "./instructions/link.ts";
import { skillChanged } from "./instructions/skills.ts";
import { log } from "./log.ts";

// /api/skills (docs/design.md, Instructions and skills): the host registers, updates and removes skills. A preview reads
// GitHub and stores nothing; a confirm reads every file by the previewed SHA here in the Worker, so the Hub is never
// held by a fetch, and hands the Hub the checked skill in one call, which stores it in one transaction.

const SkillPath = v.object({ name: SkillName });

type AppContext = Context<{ Bindings: Env }>;

// The GitHub App's client, or the answer when the App's settings are missing or malformed: every read of a skill needs
// the App (the design makes no GitHub call without it).
function githubClient(c: AppContext): GithubClient | Response {
  const config = readGithubAppConfig(c.env);
  if (config === null) {
    return errorResponse(c, "internal", "the GitHub App is not configured");
  }
  if (!config.ok) {
    return errorResponse(c, "internal", `the GitHub App is misconfigured: ${config.issues.join("; ")}`);
  }
  return githubFor(c.env, config.config);
}

// A read of GitHub's skill, or the answer its failure gets.
async function fromGithub<T>(c: AppContext, phase: string, read: () => Promise<T>): Promise<T | Response> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SkillFailure) {
      log("prq.skill.fetch_failed", { phase, error: error.code }, "warn");
      return errorResponse(c, error.code, error.detail);
    }
    throw error;
  }
}

// What an update's preview reads: a ref of the registered repository and path, or a new link.
type UpdateTarget = { ref: string } | { link: SkillLink };

export function skillRoutes(bound: CallBound) {
  // A preview of what an update would pin, beside the registered version: the name must stay.
  const previewUpdate = async (c: AppContext, name: string, target: UpdateTarget, github: GithubClient) => {
    const current = await hubCall(bound, c.env, "the Hub's skill", (hub) => hub.skill(name));
    if (current === null) {
      return errorResponse(c, "not_found", `no skill named ${name} is registered`);
    }
    const preview = await fromGithub(c, "preview", () =>
      previewSkill(github, "link" in target ? target : { source: current.source, ref: target.ref }),
    );
    if (preview instanceof Response) {
      return preview;
    }
    if (preview.name !== name) {
      return errorResponse(c, "invalid_skill", `the skill there is named ${preview.name}, not ${name}`);
    }
    const { source, ref, sha, rev, allowedTools } = current;
    const answer: SkillUpdatePreview = { ...preview, current: { source, ref, sha, rev, allowedTools } };
    return c.json(answer);
  };

  return (
    new Hono<{ Bindings: Env }>()
      // A link's preview: the ref resolved, the tree and SKILL.md read by its SHA. A name already registered gets 409.
      .post("/preview", vValidator("json", PreviewSkillRequest, invalidRequest), async (c) => {
        const link = parseSkillLink(c.req.valid("json").url);
        if ("issue" in link) {
          return errorResponse(c, "bad_request", link.issue);
        }
        const github = githubClient(c);
        if (github instanceof Response) {
          return github;
        }
        const preview = await fromGithub(c, "preview", () => previewSkill(github, { link }));
        if (preview instanceof Response) {
          return preview;
        }
        if ((await hubCall(bound, c.env, "the Hub's skill", (hub) => hub.skill(preview.name))) !== null) {
          return errorResponse(c, "skill_exists", `a skill named ${preview.name} is registered already; update it`);
        }
        return c.json(preview);
      })
      // A confirm: the previewed SHA's files, stored under the previewed name while it is free. One that lands after
      // the route stopped waiting stores the skill all the same, and the host's resend gets 409.
      .post("/", vValidator("json", RegisterSkillRequest, invalidRequest), async (c) => {
        const github = githubClient(c);
        if (github instanceof Response) {
          return github;
        }
        const version = await fromGithub(c, "confirm", () => fetchSkill(github, c.req.valid("json")));
        if (version instanceof Response) {
          return version;
        }
        const stored = await hubCall(
          bound,
          c.env,
          "the Hub's skill registration",
          async (hub): Promise<Skill | ErrorResponse> => hub.registerSkill(version),
        );
        return "error" in stored ? errorResponse(c, stored.error, stored.detail) : c.json(stored, 201);
      })
      // An update's preview, by a ref of the registered repository and path, or by a new link.
      .post(
        "/:name/preview",
        vValidator("param", SkillPath, invalidRequest),
        vValidator("json", PreviewUpdateRequest, invalidRequest),
        async (c) => {
          const body = c.req.valid("json");
          const target = "url" in body ? parseSkillLink(body.url) : body;
          if ("issue" in target) {
            return errorResponse(c, "bad_request", target.issue);
          }
          const github = githubClient(c);
          if (github instanceof Response) {
            return github;
          }
          const { name } = c.req.valid("param");
          return previewUpdate(c, name, "ref" in target ? target : { link: target }, github);
        },
      )
      // An update's confirm: the previewed SHA's files replace the registered version while the registration is at the
      // revision the update was previewed against. That is checked before GitHub is read, again when the read fails (a
      // changed registration is the answer, not GitHub's failure), and in the Hub's transaction that stores it.
      .put(
        "/:name",
        vValidator("param", SkillPath, invalidRequest),
        vValidator("json", UpdateSkillRequest, invalidRequest),
        async (c) => {
          const { name } = c.req.valid("param");
          const { expectedRev, ...request } = c.req.valid("json");
          if (request.name !== name) {
            return errorResponse(c, "bad_request", "the body names another skill than the path");
          }
          const github = githubClient(c);
          if (github instanceof Response) {
            return github;
          }
          const changed = async () => {
            const current = await hubCall(bound, c.env, "the Hub's skill", (hub) => hub.skill(name));
            return current?.rev === expectedRev ? null : errorResponse(c, "skill_changed", skillChanged(name));
          };
          const before = await changed();
          if (before !== null) {
            return before;
          }
          const version = await fromGithub(c, "confirm", () => fetchSkill(github, request));
          if (version instanceof Response) {
            return (await changed()) ?? version;
          }
          const stored = await hubCall(
            bound,
            c.env,
            "the Hub's skill update",
            async (hub): Promise<Skill | ErrorResponse> => hub.updateSkill(version, expectedRev),
          );
          return "error" in stored ? errorResponse(c, stored.error, stored.detail) : c.json(stored);
        },
      )
      // Removes whatever version is registered.
      .delete("/:name", vValidator("param", SkillPath, invalidRequest), async (c) => {
        const { name } = c.req.valid("param");
        const removed = await hubCall(bound, c.env, "the Hub's skill removal", (hub) => hub.removeSkill(name));
        return removed ? c.body(null, 204) : errorResponse(c, "not_found", `no skill named ${name} is registered`);
      })
  );
}
