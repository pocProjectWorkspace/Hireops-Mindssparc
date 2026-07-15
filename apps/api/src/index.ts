import "./bootstrap";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { sql as poolSql } from "@hireops/db";
import { tenantContext, type TenantContextVars } from "./middleware/tenant-context";
import { optionalAuth, type OptionalAuthVars } from "./middleware/optional-auth";
import { testRoutes } from "./routes/test";
import { uploadRoutes } from "./routes/upload";
import { onboardingDocumentRoutes } from "./routes/onboarding-documents";
import { linksRoutes } from "./routes/links";
import { offersRoutes } from "./routes/offers";
import { appRouter } from "./trpc/router";
import type { HonoTRPCContext } from "./trpc/trpc-core";
import { baseLog, sentry } from "./lib/observability";

const app = new Hono<{
  Variables: TenantContextVars & Partial<OptionalAuthVars>;
}>();

/**
 * CORS — added by CRS-01 so the public apply form (and the Module 4
 * candidate offer accept page) can hit the api from the portal's
 * origin in dev. Dev allow-list = the three local dev ports. Prod
 * allow-list lives behind CORS_ALLOWED_ORIGINS (comma-separated); if
 * unset we fall back to the dev list so a misconfigured env can't
 * lock everyone out. Production deploys SHOULD set this explicitly.
 */
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const defaultDevOrigins = [
  "http://localhost:3000",
  "http://localhost:3002",
  "http://localhost:3003",
  // PARTNER-01: the partner portal dev server (see apps/partner-portal).
  "http://localhost:3005",
];
const allowedOrigins = corsOrigins.length > 0 ? corsOrigins : defaultDevOrigins;
app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", "authorization", "x-request-id"],
    credentials: true,
    maxAge: 600,
  }),
);

// Liveness probes. /health stays for backwards compat; /api/healthz is
// the documented endpoint going forward. Neither touches the DB —
// readiness lands in a separate ticket alongside deployment work.
app.get("/health", (c) => c.json({ ok: true }));
app.get("/api/healthz", (c) =>
  c.json({
    ok: true,
    service: "hireops-api",
    version: process.env.APP_VERSION ?? "dev",
    timestamp: new Date().toISOString(),
  }),
);

// Existing whoami/tenants test endpoints — gated behind the strict
// tenant-context middleware (401 on missing / invalid JWT) so the
// tenant-scoped tx is opened around the handler.
app.use("/test/*", tenantContext);
app.route("/test", testRoutes);

// Upload + tRPC live behind optionalAuth — public procedures need to
// work pre-login, protected procedures throw UNAUTHORIZED themselves.
// optionalAuth populates c.var.{log,requestId,tenantId,userId,claims}.
app.use("/api/upload/*", optionalAuth);
app.route("/api/upload", uploadRoutes);

// Onboarding document upload + download (ONBOARD-05). Behind the STRICT
// tenant-context middleware — these carry heavy PII, so unlike the public
// resume upload they 401 without a recruiter JWT and run RLS-scoped. The
// download route writes a pii_access_log row per read (PII-01).
app.use("/api/onboarding-documents/*", tenantContext);
app.route("/api/onboarding-documents", onboardingDocumentRoutes);

// Signed-link verification is intentionally unauthenticated — the link
// IS the credential. The handler does its own audit insert.
app.route("/api/links", linksRoutes);

// Public candidate offer accept/decline — signed-link gated, same
// reasoning as /api/links. Handlers do their own signed_link_uses inserts.
app.route("/api/offers", offersRoutes);

app.use("/trpc/*", optionalAuth);
app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, c) => {
      const ctx: HonoTRPCContext = {
        tenantId: c.var.tenantId ?? null,
        userId: c.var.userId ?? null,
        roles: c.var.roles ?? [],
        claims: c.var.claims ?? null,
        db: undefined,
        sql: poolSql,
        log: c.var.log,
        requestId: c.var.requestId,
        userAgent: c.req.header("user-agent") ?? null,
        ipAddress:
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
          c.req.header("x-real-ip") ??
          null,
      };
      // @hono/trpc-server types the return as Record<string, unknown>;
      // we hand back our shaped HonoTRPCContext but the adapter just
      // forwards it to tRPC's createContext callback, which reads it
      // through the typed initTRPC.context<HonoTRPCContext>() lens.
      return ctx as unknown as Record<string, unknown>;
    },
    onError: ({ error, path }) => {
      // Surface unexpected procedure errors via the standard pino +
      // Sentry path. Zod errors and explicit TRPCErrors flow through
      // the error formatter; this catches internal failures.
      if (error.code === "INTERNAL_SERVER_ERROR") {
        baseLog.error({ err: error, path }, "trpc procedure threw");
        sentry.captureException(error, { extra: { path: String(path) } });
      }
    },
  }),
);

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
