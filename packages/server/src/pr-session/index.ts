import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Connection } from "agents";

import { refuseSubAgent, sendServerVersion } from "../agents.ts";
import { migrate, PR_SESSION_SCHEMA } from "../schema.ts";

// One pull request's conversation (named by sessionName).
export class PrSession extends AIChatAgent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, PR_SESSION_SCHEMA);
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
}
