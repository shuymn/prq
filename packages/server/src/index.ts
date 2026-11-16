import { Hono } from "hono";

import { access } from "./access.ts";
import { routeAgents } from "./agents.ts";
import { apiRoutes } from "./api-routes.ts";
import { noStore, notFound, onError, prqVersion } from "./http.ts";

export { Hub } from "./hub.ts";
export { PrSession } from "./pr-session/index.ts";

const app = new Hono<{ Bindings: Env }>();

app.use(noStore);
app.use("/cli/*", prqVersion);
// Routes that bypass Access (only /webhook) are mounted above this line; everything below it needs a valid token.
app.use(access());
app.route("/api", apiRoutes);
app.all("/agents/*", routeAgents);

app.notFound(notFound);
app.onError(onError);

export default app;
