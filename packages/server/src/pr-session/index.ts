import { AIChatAgent } from "@cloudflare/ai-chat";
import { MessageType } from "@cloudflare/ai-chat/types";
import type { Connection } from "agents";
import type { UIMessage } from "ai";

import { refuseSubAgent, sendServerVersion } from "../agents.ts";
import { log } from "../log.ts";
import { migrate, PR_SESSION_SCHEMA } from "../schema.ts";
import { addedMessages, questionsOnly, refusedFrame, WriteQueue } from "./history.ts";

// One pull request's conversation (named by sessionName). Its stored history is append-only.
export class PrSession extends AIChatAgent<Env> {
  readonly #writes = new WriteQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, PR_SESSION_SCHEMA);
    // AIChatAgent installs its frame handler in its constructor. This wrapper is where a client's input enters: it
    // refuses the frames that write history other than through a chat request, takes the messages a client may not add
    // out of a chat request (whose list the SDK also relays to the other connections), and passes the rest through.
    // Whether a message is stored is read from this.messages, synchronously, so frames keep their order; a stored
    // non-question outside it (a history over hydrationByteBudget) is only left out of the request, as it is stored.
    const handle = this.onMessage.bind(this);
    this.onMessage = (connection, message) => {
      const refused = refusedFrame(message);
      if (refused !== null) {
        log("prq.chat.refused", { pr: this.name, type: refused }, "warn");
        return;
      }
      let cached: ReadonlySet<unknown> | undefined;
      const request = questionsOnly(message, (id) => {
        cached ??= new Set(this.messages.map((stored) => stored.id));
        return cached.has(id);
      });
      if (request.removed > 0) {
        const type = MessageType.CF_AGENT_USE_CHAT_REQUEST;
        log("prq.chat.refused", { pr: this.name, type, messages: request.removed }, "warn");
      }
      return handle(connection, request.message);
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
