import "./bootstrap";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { tenantContext, type TenantContextVars } from "./middleware/tenant-context";
import { testRoutes } from "./routes/test";
import { baseLog, sentry } from "./lib/observability";

const app = new Hono<{ Variables: TenantContextVars }>();

// Health endpoint — no auth required, no tenant scoping. Cheap, doesn't
// touch the DB; the load balancer / k8s probes hit this every few seconds.
app.get("/health", (c) => c.json({ ok: true }));

// All other routes go through the tenant-context middleware (which also
// sets c.var.log + c.var.requestId).
app.use("/test/*", tenantContext);
app.route("/test", testRoutes);

// Hono onError fires for any uncaught exception in a handler. We capture
// to Sentry — including request context if the tenant-context middleware
// got far enough to populate c.var — then return a 500 with the request
// id so callers can correlate. We do not surface the error message to
// the client; that stays in the structured log + Sentry payload.
app.onError((err, c) => {
  const log = c.var.log ?? baseLog;
  const requestId = c.var.requestId ?? c.req.header("x-request-id") ?? null;
  log.error(
    { err, request_id: requestId, path: c.req.path, method: c.req.method },
    "unhandled error in request handler",
  );
  sentry.captureException(err, {
    tags: requestId ? { request_id: requestId } : undefined,
    extra: { path: c.req.path, method: c.req.method },
  });
  return c.json({ error: "internal_server_error", request_id: requestId }, 500);
});

const port = Number(process.env.PORT ?? 3001);

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port }, ({ port: p }) => {
    baseLog.info({ port: p }, "apps/api listening");
  });
}

export { app };
