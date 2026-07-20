import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PersonaDashboard } from "@/components/dashboard/PersonaDashboard";
import { HrHeadDashboard } from "@/components/dashboard/HrHeadDashboard";
import { RecruiterDashboard } from "@/components/dashboard/RecruiterDashboard";
import { AdminDashboard } from "@/components/dashboard/AdminDashboard";
import { PanelDashboard } from "@/components/panel/PanelDashboard";
import { RequirementOwnerDashboard } from "@/components/requirements/RequirementOwnerDashboard";

export const dynamic = "force-dynamic"; // Auth-gated, per-session data.

/**
 * DASH-01 / HRHEAD-01 — the persona landing dashboard (`/dashboard`).
 *
 * The authenticated home surface: `/` redirects here. getMyDashboard (in-process
 * caller) returns the KPI + recommended-action payload for the caller's persona.
 * HRHEAD-01: an hr_head caller additionally gets the bespoke HR-head surface
 * (getHrHeadDashboardExtras — hero KPI + funnel + inline approvals + risk rail),
 * with the getMyDashboard hr_head actions feeding its "Tasks due today" strip.
 * Every other persona (incl. admin) keeps the DASH-01 PersonaDashboard.
 * Server-rendered — the page lands with real data, no client loading flash.
 */
export default async function DashboardPage() {
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);
  const data = await caller.getMyDashboard();

  // admin gets the bespoke admin console home (AD-01) — governance tiles + tasks
  // + quick actions. Takes precedence over every other persona branch.
  const isAdmin = session.roles.includes("admin");
  // hr_head (but not the admin superset) gets the bespoke surface.
  const isHrHead = session.roles.includes("hr_head") && !session.roles.includes("admin");
  // panel_member (but not the admin superset, and not also an hr_head) gets the
  // bespoke panel workboard as home (PANEL-01).
  const isPanel =
    session.roles.includes("panel_member") &&
    !session.roles.includes("admin") &&
    !session.roles.includes("hr_head");
  // hiring_manager (the requirement owner; not admin/hr_head) gets the bespoke
  // requirement-owner dashboard (RO-01).
  const isRequirementOwner =
    session.roles.includes("hiring_manager") &&
    !session.roles.includes("admin") &&
    !session.roles.includes("hr_head") &&
    !session.roles.includes("panel_member");
  // recruiter (not admin/hr_head; and not primarily a requirement owner) gets
  // the bespoke recruiter dashboard (RECR-01).
  const isRecruiter =
    session.roles.includes("recruiter") &&
    !session.roles.includes("admin") &&
    !session.roles.includes("hr_head") &&
    !isRequirementOwner;

  return (
    <AppShell
      title="Home"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="home"
      user={sessionUserChip(session)}
    >
      {isAdmin ? (
        <AdminDashboard
          initialExtras={await caller.getAdminDashboardExtras()}
          tasks={data.actions}
          displayName={session.email?.split("@")[0] ?? "there"}
        />
      ) : isHrHead ? (
        <HrHeadDashboard
          initialExtras={await caller.getHrHeadDashboardExtras()}
          tasks={data.actions}
          displayName={session.email?.split("@")[0] ?? "there"}
        />
      ) : isPanel ? (
        <PanelDashboard
          initialBoard={await caller.getPanelDashboard()}
          initialInterviews={(await caller.listMyPanelInterviews({})).rows}
          displayName={session.email?.split("@")[0] ?? "there"}
        />
      ) : isRequirementOwner ? (
        <RequirementOwnerDashboard
          initial={await caller.getRequirementOwnerDashboard()}
          displayName={session.email?.split("@")[0] ?? "there"}
        />
      ) : isRecruiter ? (
        <RecruiterDashboard
          initialExtras={await caller.getRecruiterDashboardExtras()}
          initialInterviews={
            (await caller.listUpcomingInterviews({ status: "scheduled", limit: 5 })).rows
          }
          kpis={data.kpis}
          displayName={session.email?.split("@")[0] ?? "there"}
        />
      ) : (
        <PersonaDashboard data={data} />
      )}
    </AppShell>
  );
}
