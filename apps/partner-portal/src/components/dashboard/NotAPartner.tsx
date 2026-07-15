import { Card } from "@/components/ui";

/**
 * Shown when a Supabase identity authenticates but has no active partner_users
 * row — i.e. partnerGetMe threw FORBIDDEN. This is exactly how an internal
 * Kyndryl recruiter (who has a tenant_user_membership but no partner_users
 * row) is turned away. Honest, calm, with a route back out.
 */
export function NotAPartner({ email }: { email?: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-lg font-bold text-white"
          >
            H
          </span>
          <span className="text-xl font-semibold tracking-tight text-neutral-900">
            HireOps <span className="font-normal text-neutral-500">Partners</span>
          </span>
        </div>
        <Card className="shadow-2">
          <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
            Not a partner account
          </h1>
          <p className="mt-2 text-sm text-neutral-600">
            {email ? (
              <>
                <span className="font-medium text-neutral-800">{email}</span> is signed in, but it
                isn&apos;t linked to a sourcing-partner organisation.
              </>
            ) : (
              <>This account isn&apos;t linked to a sourcing-partner organisation.</>
            )}{" "}
            If you&apos;re a Kyndryl employee or a candidate, please use the portal meant for you.
          </p>
          <p className="mt-3 text-sm text-neutral-500">
            Think this is a mistake? Contact your Kyndryl point of contact to have your partner
            access provisioned.
          </p>
          <div className="mt-6">
            <a
              href="/logout"
              className="inline-flex h-9 items-center justify-center rounded-button bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700"
            >
              Sign out
            </a>
          </div>
        </Card>
      </div>
    </main>
  );
}
