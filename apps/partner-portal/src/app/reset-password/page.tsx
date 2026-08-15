import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Public route (PUBLIC_PATHS, P1.4) — the landing leg of password recovery.
 * The emailed link redirects here; the client form waits for the recovery
 * session and then lets the visitor set a new password.
 */
export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <img
            src="/logo/hireops-mark.png"
            alt=""
            aria-hidden
            width={36}
            height={36}
            className="h-9 w-9 shrink-0 object-contain"
          />
          <span className="text-xl font-semibold tracking-tight text-neutral-900">
            HireOps <span className="font-normal text-neutral-500">Partners</span>
          </span>
        </div>
        <Card className="shadow-2" padded={false}>
          <div className="p-6">
            <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
              Choose a new password
            </h1>
            <p className="mt-1 mb-6 text-sm text-neutral-500">
              You followed a reset link — set the new password for your account.
            </p>
            <ResetPasswordForm />
          </div>
        </Card>
      </div>
    </main>
  );
}
