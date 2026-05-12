import { Hono } from "hono";
import { tenants } from "@hireops/db";
import type { TenantContextVars } from "../middleware/tenant-context";

export const testRoutes = new Hono<{ Variables: TenantContextVars }>();

// GET /test/whoami — returns the resolved tenant/user/roles from the JWT.
testRoutes.get("/whoami", (c) => {
  return c.json({
    tenantId: c.var.tenantId,
    userId: c.var.userId,
    roles: c.var.roles,
  });
});

// GET /test/tenants — queries the tenants table through the request-bound
// connection. RLS scopes the result to exactly the caller's tenant.
testRoutes.get("/tenants", async (c) => {
  const rows = await c.var.db.select().from(tenants);
  return c.json({ rows, count: rows.length });
});
