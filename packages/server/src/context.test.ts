import { afterEach, describe, expect, it, vi } from "vitest";

import { captureLogs } from "./test/access.ts";
import { type AgentSocket, question, storedMessages } from "./test/chat.ts";
import { cloudSession, untilState } from "./test/cloud.ts";
import { answerScript, finish, ScriptedModel, text, useCloudModel, useWorkspace } from "./test/model.ts";
import { gate, jobOf, retryIn } from "./test/session.ts";
import { push, sha } from "./test/webhook.ts";

const sockets: AgentSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
});

const Q0 = question("q0");
const Q1 = question("q1");
const Q2 = question("q2");
const Q3 = question("q3");

describe("model context", () => {
  it("gives each job the results stored so far, each answer after its question, then its own question", async () => {
    captureLogs();
    const session = await cloudSession("context", sockets);
    const { stub, client, ref } = session;
    const analysis = await gate(stub);
    const model = new ScriptedModel().add(
      [...text("partial zero"), { fail: new Error("lost") }],
      [...text("summary"), { hold: analysis }, finish()],
      answerScript("answer one"),
      answerScript("answer two"),
      answerScript("answer zero"),
      answerScript("answer three"),
    );
    useCloudModel(model);
    useWorkspace();

    // Q0 fails, keeping its text as incomplete.
    await client.chat([Q0]);
    await untilState(stub, "q0", "failed");
    // Q1 and Q2 are asked while the analysis runs; their requests' turns wait behind its turn, so settle gives them
    // their jobs.
    await push(ref, "a");
    await analysis.reached();
    const asked = [client.chat([Q0, Q1]), client.chat([Q0, Q1, Q2])];
    await vi.waitFor(async () => expect(await storedMessages(session.path, session.token)).toHaveLength(4));
    await stub.settle();
    await analysis.open();
    await Promise.all(asked);
    await untilState(stub, "q2", "done");
    // Q0 retried after them, then Q3.
    await retryIn(stub, (await jobOf(stub, "q0")).job_id);
    await untilState(stub, "q0", "done");
    await client.chat([Q0, Q1, Q2, Q3]);
    await untilState(stub, "q3", "done");

    const S = "summary";
    expect(model.prompts().map((prompt) => prompt.map((message) => message.text))).toEqual([
      ["question q0"],
      [`Summarize the pull request at head ${sha("a")}.`],
      [S, "question q1"],
      [S, "question q1", "answer one", "question q2"],
      [S, "question q1", "answer one", "question q2", "answer two", "question q0"],
      [S, "question q1", "answer one", "question q2", "answer two", "question q0", "answer zero", "question q3"],
    ]);
  });
});
