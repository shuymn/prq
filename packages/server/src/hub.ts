import { Agent, type Connection } from "agents";

import { refuseSubAgent, sendServerVersion } from "./agents.ts";
import { HUB_SCHEMA, migrate } from "./schema.ts";

// The one Hub (HUB_NAME): the pool of local agents and the notifications they wait on.
export class Hub extends Agent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, HUB_SCHEMA);
  }

  override onConnect(connection: Connection): void {
    sendServerVersion(connection);
  }

  override async onBeforeSubAgent(): Promise<Response> {
    return refuseSubAgent();
  }
}
