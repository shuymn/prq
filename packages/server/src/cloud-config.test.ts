import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLOUD_MISCONFIGURED } from "./pr-session/cloud.ts";
import { captureLogs, events } from "./test/access.ts";
import { type AgentSocket, question } from "./test/chat.ts";
import { cloudSession } from "./test/cloud.ts";
import { MODEL_ENV, TEST_KEY, useModelEnv } from "./test/provider.ts";
import { jobOf, prSessionSeams, sessionSql } from "./test/session.ts";

// The session's model from its env: MODEL_* set and valid give the provider's model, once per isolate; set in part or
// malformed, cloud jobs fail naming the variables, never their values. (None set: cloud.test.ts.)

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q1 = question("q1");

const misconfigured: [string, Partial<typeof MODEL_ENV>, string][] = [
  [
    "only some variables are set",
    { MODEL_API_KEY: TEST_KEY, MODEL_ID: MODEL_ENV.MODEL_ID },
    "MODEL_BASE_URL is missing; MODEL_CONTEXT_TOKENS is missing",
  ],
  [
    "the window is below the floor",
    { ...MODEL_ENV, MODEL_CONTEXT_TOKENS: "16383" },
    "MODEL_CONTEXT_TOKENS is below 16,384",
  ],
  [
    "the base URL is not https",
    { ...MODEL_ENV, MODEL_BASE_URL: "http://provider.example/v1" },
    "MODEL_BASE_URL is not an https URL",
  ],
];

describe("misconfigured", () => {
  it.for(misconfigured)(
    "fails a cloud job when %s, naming the variables and never their values",
    async ([, vars, issues]) => {
      const logs = captureLogs();
      const { stub, client } = await cloudSession("config", sockets);
      await useModelEnv(stub, vars);

      await client.chat([Q1]);

      const failure = `${CLOUD_MISCONFIGURED}: ${issues}`;
      expect(await jobOf(stub, "q1")).toMatchObject({ state: "failed", failure });
      const [invalid] = logs.filter((log) => log.entry["event"] === "prq.config.invalid");
      expect(invalid).toEqual({
        level: "error",
        entry: { event: "prq.config.invalid", issues: issues.split("; ") },
      });
      for (const shown of [JSON.stringify(logs), JSON.stringify(client.frames), JSON.stringify(await stub.view())]) {
        expect(shown).not.toContain(TEST_KEY);
        expect(shown).not.toContain("provider.example");
      }
    },
  );

  it("fails a running job that settle finds while the model is misconfigured", async () => {
    const logs = captureLogs();
    const { stub, client } = await cloudSession("config", sockets);
    await client.chat([Q1]);
    // A job left running by a turn of an earlier instance, whose configuration was valid.
    await sessionSql(
      stub,
      "UPDATE prq_jobs SET state = 'running', failure = NULL, unresolved_failure = 0, turn_id = 'lost-turn' WHERE target = 'q1'",
    );
    await useModelEnv(stub, { ...MODEL_ENV, MODEL_ID: "" });

    await stub.settle();

    const failure = `${CLOUD_MISCONFIGURED}: MODEL_ID is empty`;
    expect(await jobOf(stub, "q1")).toMatchObject({ state: "failed", failure, turn_id: null });
    expect(events(logs, "prq.job.failed").at(-1)).toMatchObject({ from: "running", to: "failed", reason: failure });
  });
});

describe("configured", () => {
  it("uses one model per isolate, the configured one", async () => {
    const { stub } = await cloudSession("config", sockets);
    await useModelEnv(stub);

    const models = await runInDurableObject(stub, (instance) => {
      const seams = prSessionSeams(instance);
      const first = seams.cloudModel();
      return { same: first !== undefined && first === seams.cloudModel(), modelId: first?.modelId };
    });

    expect(models).toEqual({ same: true, modelId: MODEL_ENV.MODEL_ID });
  });
});
