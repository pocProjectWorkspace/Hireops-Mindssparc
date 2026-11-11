import { CandidateShell } from "@/components/candidate/CandidateShell";
import { CandidateLoginClient } from "@/app/candidate/login/CandidateLoginClient";

export const dynamic = "force-dynamic"; // reads ?email search param

/**
 * C1-BUGS BUG-13 — the tenant-scoped candidate sign-in door
 * (/t/<tenantSlug>/candidate/login). Same surface as /candidate/login, with
 * the tenant taken from the route, so activation never falls back to a
 * hard-coded tenant. Public via the middleware's /t/ prefix.
 */
export default function TenantCandidateLoginPage({ params }: { params: { tenantSlug: string } }) {
  return (
    <CandidateShell>
      <CandidateLoginClient routeTenantSlug={params.tenantSlug} />
    </CandidateShell>
  );
}
