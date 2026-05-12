import "./bootstrap";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { tenantContext } from "./middleware/tenant-context";
import { testRoutes } from "./routes/test";

const app = new Hono();

// Health endpoint — no auth required, no tenant scoping.
app.get("/health", (c) => c.json({ ok: true }));

// All other routes go through the tenant-context middleware.
app.use("/test/*", tenantContext);
app.route("/test", testRoutes);

const port = Number(process.env.PORT ?? 3001);

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port }, ({ port: p }) => {
    console.log(`apps/api listening on http://localhost:${p}`);
  });
}

export { app };
