import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Connection } from "agents";
import type { UIMessage } from "ai";

import { refuseSubAgent, sendServerVersion } from "../agents.ts";
import { log } from "../log.ts";
import { migrate, PR_SESSION_SCHEMA } from "../schema.ts";
import { addedMessages, refusedFrame, WriteQueue } from "./history.ts";

// One pull request's conversation (named by sessionName). Its stored history is append-only.
export class PrSession extends AIChatAgent<Env> {
  readonly #writes = new WriteQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, PR_SESSION_SCHEMA);
    // AIChatAgent installs its frame handler in its constructor; this wrapper refuses the frames that would write
    // history around persistMessages and passes everything else, the chat request included, through.
    const handle = this.onMessage.bind(this);
    this.onMessage = (connection, message) => {
      const refused = refusedFrame(message);
      if (refused !== null) {
        log("prq.chat.refused", { pr: this.name, type: refused }, "warn");
        return;
      }
      return handle(connection, message);
    };
  }

  override onConnect(connection: Connection): void {
    sendServerVersion(connection);
  }

  override async onBeforeSubAgent(): Promise<Response> {
    return refuseSubAgent();
  }

  // No model turn runs: a question is stored and nothing else happens.
  override async onChatMessage(): Promise<Response | undefined> {
    return undefined;
  }

  // Every history write the SDK makes comes here. A chat request passes the client's whole list (asking for stored
  // messages it lacks to be deleted); only messages with new IDs are added, after the stored ones, and the saved list
  // goes to every connection, the sender included, since the SDK has already relayed the client's list to the others.
  override persistMessages(messages: UIMessage[]): Promise<void> {
    return this.#writes.run(() => this.#insertMessages(messages));
  }

  // Inside the write queue: decides what is new against the history as it is now, not as it was when the write was
  // requested.
  async #insertMessages(messages: UIMessage[]): Promise<void> {
    const cached = new Set(this.messages.map((message) => message.id));
    // this.messages holds the most recent history only; an ID outside it is looked up in storage.
    const session = this.sessions.session();
    const added = await addedMessages(
      messages,
      async (id) => cached.has(id) || (await session.getMessage(id)) !== null,
    );
    await super.persistMessages([...this.messages, ...added]);
  }
}
