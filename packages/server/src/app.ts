import { Hono } from "hono";

import { access } from "./access.ts";
import { routeAgents } from "./agents.ts";
import { apiRoutes } from "./api-routes.ts";
import { cliRoutes } from "./cli-routes.ts";
import { type CallBound, noStore, notFound, onError, prqVersion } from "./http.ts";
import { withTimeout } from "./wait.ts";

// The Worker's routes and middleware. `bound` limits each route's calls to Durable Objects; tests pass one they end
// by hand.
export function createApp(bound: CallBound = withTimeout) {
  const app = new Hono<{ Bindings: Env }>();

  app.use(noStore);
  app.use("/cli/*", prqVersion);
  // Routes that bypass Access (only /webhook) are mounted above this line; everything below it needs a valid token.
  app.use(access());
  app.route("/cli", cliRoutes(bound));
  app.route("/api", apiRoutes(bound));
  app.all("/agents/*", routeAgents);

  app.notFound(notFound);
  app.onError(onError);
  return app;
}
