import { AIChatAgent } from "@cloudflare/ai-chat";
import { MessageType } from "@cloudflare/ai-chat/types";
import type { HistoryChangedMessage } from "@prq/protocol";
import type { Connection } from "agents";
import type { UIMessage } from "ai";

import { refuseSubAgent, sendServerVersion } from "../agents.ts";
import { log } from "../log.ts";
import { migrate, PR_SESSION_SCHEMA } from "../schema.ts";
import { SerialQueue } from "../wait.ts";
import { addedMessages, isChatList, questionsOnly, refusedChatResponse, refusedFrame } from "./history.ts";

// One pull request's conversation (named by sessionName). Its stored history is append-only.
export class PrSession extends AIChatAgent<Env> {
  readonly #writes = new SerialQueue("a history write");

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, PR_SESSION_SCHEMA);
    // AIChatAgent installs its frame handler in its constructor. This wrapper is where a client's input enters: it
    // refuses the frames that write history other than through a chat request (the SDK client waits for no answer to
    // them), refuses a chat request not in the expected shape with a failed response, takes the messages a client may
    // not add out of a chat request, and passes the rest through.
    // Whether a message is stored is read from this.messages, synchronously, so frames keep their order; a stored
    // non-question outside it (a history over hydrationByteBudget) is only left out of the request, as it is stored.
    const handle = this.onMessage.bind(this);
    this.onMessage = (connection, message) => {
      const refused = refusedFrame(message);
      if (refused !== null) {
        log("prq.chat.refused", { pr: this.name, type: refused }, "warn");
        return;
      }
      let cached: ReadonlySet<string> | undefined;
      const request = questionsOnly(message, (id) => {
        cached ??= new Set(this.messages.map((stored) => stored.id));
        return cached.has(id);
      });
      const type = MessageType.CF_AGENT_USE_CHAT_REQUEST;
      if ("refusedId" in request) {
        log("prq.chat.refused", { pr: this.name, type, malformed: true }, "warn");
        if (request.refusedId !== null) {
          connection.send(refusedChatResponse(request.refusedId));
        }
        return;
      }
      if (request.removed > 0) {
        log("prq.chat.refused", { pr: this.name, type, messages: request.removed }, "warn");
      }
      return handle(connection, request.message);
    };
  }

  override onConnect(connection: Connection): void {
    sendServerVersion(connection);
  }

  // Every chat list a connection receives comes from #sendHistory, after a save. The SDK's own lists are not sent: the
  // client's list it relays to the other connections before saving, and its cached list after a save.
  override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
    if (!isChatList(message)) {
      super.broadcast(message, without);
    }
  }

  override async onBeforeSubAgent(): Promise<Response> {
    return refuseSubAgent();
  }

  // No model turn runs: a question is stored and nothing else happens.
  override async onChatMessage(): Promise<Response | undefined> {
    return undefined;
  }

  // The history writes of a chat request and of the server come here (the SDK's streaming paths write around it, and
  // stay unused while onChatMessage returns undefined). A chat request passes the client's whole list (asking for
  // stored messages it lacks to be deleted); only messages with new IDs are added, after the stored ones, and the
  // stored history then goes to every connection, the sender included.
  override persistMessages(messages: UIMessage[]): Promise<void> {
    return this.#writes.run(() => this.#insertMessages(messages));
  }

  // Inside the write queue: decides what is new against the history as it is now, not as it was when the write was
  // requested.
  async #insertMessages(messages: UIMessage[]): Promise<void> {
    const cached = new Set(this.messages.map((message) => message.id));
    // this.messages holds the most recent history only (hydrationByteBudget); an ID outside it is looked up in storage.
    const session = this.sessions.session();
    const added = await addedMessages(
      messages,
      async (id) => cached.has(id) || (await session.getMessage(id)) !== null,
    );
    await super.persistMessages([...this.messages, ...added]);
    await this.#sendHistory();
  }

  // Sends every connection the stored history, as the list a client replaces its own with. It is read within the
  // budget the SDK keeps history in memory under. A longer history goes as a HistoryChangedMessage instead, since its
  // most recent part would replace the whole list a client has; the client reloads it through get-messages.
  async #sendHistory(): Promise<void> {
    const history = await this.sessions.session().getRecentHistory(this.hydrationByteBudget);
    if (history.truncated) {
      log("prq.chat.history_over_budget", { pr: this.name, bytes: history.totalContentBytes });
      const changed: HistoryChangedMessage = { type: "prq:history-changed" };
      super.broadcast(JSON.stringify(changed));
      return;
    }
    super.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: history.messages }));
  }
}
