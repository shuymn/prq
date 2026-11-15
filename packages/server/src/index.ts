import { routeAgentRequest } from "agents";
import { Hono } from "hono";

import { access } from "./access.ts";
import { apiRoutes } from "./api-routes.ts";
import { cliRoutes } from "./cli-routes.ts";
import { webhook } from "./webhook.ts";

export { Hub } from "./hub.ts";
export { PrSession } from "./pr-session/index.ts";

const app = new Hono<{ Bindings: Env }>();
app.route("/webhook", webhook);
app.use("/cli/*", access("service"));
app.route("/cli", cliRoutes);
app.use("/api/*", access("any"));
app.route("/api", apiRoutes);
// The Agents SDK socket path is inside the same Access protection.
app.use("/agents/*", access("any"));
app.all("/agents/*", async (c) => (await routeAgentRequest(c.req.raw, c.env)) ?? c.notFound());

export default app;
