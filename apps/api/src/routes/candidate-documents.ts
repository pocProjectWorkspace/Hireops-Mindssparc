/**
 * Candidate onboarding-document blob transport (CAND-02) — the REST side of the
 * candidate's own document upload + download. Two routes, BOTH candidate-
 * authenticated.
 *
 *   POST /api/candidate-documents/upload
 *     Multipart upload of an onboarding document (10MB; PDF / DOCX / JPEG /
 *     PNG). Returns an opaque `storageKey`; the blob becomes a real row only
 *     when `candidateAttachDocument` (candidateProcedure) references it —
 *     the same two-step upload-then-attach shape as the recruiter route.
 *
 *   GET /api/candidate-documents/:documentId/download
 *     Streams a document the candidate uploaded, proxied through the API
 *     (storage keys stay opaque). Person-scoped: the document must trace
 *     case → candidate → person = the caller, or it 404s. The candidate's own
 *     access is STILL an access — every read writes a pii_access_log row
 *     (reason `candidate_self_download`).
 *
 * WHY A SEPARATE ROUTE FAMILY (not the recruiter `tenantContext` mount). The
 * candidate JWT carries a verified `sub` but NO `tid` claim (the Custom Access
 * Token hook only reads tenant_user_memberships — same constraint
 * candidateProcedure solved), so the strict `tenantContext` middleware, which
 * hard-requires `tid`, 401s them. This route therefore resolves the candidate
 * from candidate_accounts itself (mirroring candidateProcedure) via the
 * service-role pool, and person-scopes every DB touch explicitly.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { sql as poolSql, recordPiiAccess } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { baseLog } from "../lib/observability";
import { verifyJwt, extractBearerToken } from "../lib/jwt";
import { getStorageClient, StorageError, StorageNotFoundError } from "../lib/storage";
import { storeUploadedDocument } from "../lib/document-upload";

interface CandidateRestVars {
  candidatePersonId: string;
  candidateTenantId: string;
  candidateUserId: string;
  requestId: string;
  log: Logger;
}

/**
 * Candidate-resolution middleware — the REST analogue of candidateProcedure.
 * Verifies the JWT, resolves the ACTIVE candidate_accounts row by auth user id
 * via the service-role pool, and stashes person + tenant on c.var. No
 * withTenantContext tx is opened: the two handlers person-scope explicitly and
 * only touch storage + a fire-and-forget pii_access_log insert.
 */
const candidateRestContext: MiddlewareHandler<{ Variables: CandidateRestVars }> = async (
  c,
  next,
) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.header("x-request-id", requestId);
  const log = baseLog.child({ request_id: requestId });

  const token = extractBearerToken(c.req.header("Authorization"));
  const result = await verifyJwt(token);
  if (!result.ok) {
    return c.json({ error: "unauthorized", reason: result.reason }, 401);
  }
  const userId = typeof result.claims.sub === "string" ? result.claims.sub : null;
  if (!userId) {
    return c.json({ error: "unauthorized", reason: "missing_sub" }, 401);
  }

  const rows = await poolSql<{ person_id: string; tenant_id: string }[]>`
    SELECT ca.person_id, ca.tenant_id
    FROM public.candidate_accounts ca
    JOIN public.tenants t ON t.id = ca.tenant_id
    WHERE ca.user_id = ${userId} AND ca.status = 'active' AND t.status = 'active'
    LIMIT 1
  `;
  const cand = rows[0];
  if (!cand) {
    return c.json({ error: "forbidden", reason: "not_a_candidate_account" }, 403);
  }

  c.set("candidatePersonId", cand.person_id);
  c.set("candidateTenantId", cand.tenant_id);
  c.set("candidateUserId", userId);
  c.set("requestId", requestId);
  c.set("log", log);
  await next();
};

export const candidateDocumentRoutes = new Hono<{ Variables: CandidateRestVars }>();

candidateDocumentRoutes.use("*", candidateRestContext);

candidateDocumentRoutes.post("/upload", async (c) => {
  let body: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid_form" }, 400);
  }
  const result = await storeUploadedDocument(body, c.var.log);
  if (!result.ok) {
    return c.json(result.body, result.status);
  }
  return c.json(result.response);
});

candidateDocumentRoutes.get("/:documentId/download", async (c) => {
  const documentId = c.req.param("documentId");

  // Person-scoped lookup: the document must belong to a case whose candidate is
  // THIS candidate's person. A cross-person / cross-tenant id resolves to no
  // row (404), never a leak.
  const [row] = await poolSql<
    {
      id: string;
      tenant_id: string;
      storage_ref: string;
      file_name: string | null;
      mime_type: string | null;
    }[]
  >`
    SELECT d.id, d.tenant_id, d.storage_ref, d.file_name, d.mime_type
    FROM public.onboarding_documents d
    JOIN public.onboarding_cases oc ON oc.id = d.case_id AND oc.tenant_id = d.tenant_id
    JOIN public.candidates c ON c.id = oc.candidate_id AND c.tenant_id = oc.tenant_id
    WHERE d.tenant_id = ${c.var.candidateTenantId}
      AND d.id = ${documentId}
      AND c.person_id = ${c.var.candidatePersonId}
    LIMIT 1
  `;
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  // The candidate's own access is still an access — log it before the bytes
  // leave (PII-01 pattern). Fire-and-forget; never blocks the download.
  recordPiiAccess({
    tenantId: row.tenant_id,
    actorUserId: c.var.candidateUserId,
    actorLabel: "candidate",
    entityType: "onboarding_document",
    entityId: row.id,
    fieldsAccessed: ["onboarding_documents.storage_ref", "onboarding_documents.file_name"],
    reason: "candidate_self_download",
    requestId: c.var.requestId,
  });

  let object: Awaited<ReturnType<ReturnType<typeof getStorageClient>["get"]>>;
  try {
    object = await getStorageClient().get(row.storage_ref);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      return c.json({ error: "blob_not_found" }, 404);
    }
    if (err instanceof StorageError) {
      c.var.log.error({ err, documentId }, "candidate document storage get failed");
      return c.json({ error: "download_failed" }, 500);
    }
    throw err;
  }

  const contentType = row.mime_type ?? object.contentType ?? "application/octet-stream";
  const downloadName = (row.file_name ?? `document-${row.id}`).replace(/["\\]/g, "_");
  return c.body(new Uint8Array(object.buffer), 200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "Content-Length": String(object.buffer.length),
    "Cache-Control": "private, no-store",
  });
});
