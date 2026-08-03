/**
 * Presentation helpers for the L&D surfaces (LD-1B). Pure — no DOM, no React —
 * so the provider vocabulary, the duration formatter and the layer labels stay
 * shared between /admin/learning, the onboarding push panel and the hire's own
 * /candidate/learning list.
 *
 * The provider and layer vocabularies MIRROR the zod enums in
 * @hireops/api-types (learningProviderSchema / learningAssignmentLayerSchema),
 * which in turn mirror the DB CHECK constraints. An unknown value degrades to a
 * humanised label rather than rendering blank, so a future provider is never
 * shown as an empty chip.
 */
import type {
  LearningAssignmentLayer,
  LearningProvider,
  LearningTrackLayer,
} from "@hireops/api-types";
import type { BadgeTone } from "@/components/ui";

// ─────────────── provider ───────────────

/** Where the material actually lives. HireOps points at it; it hosts none of it. */
export const LEARNING_PROVIDER_LABELS: Record<LearningProvider, string> = {
  workday_learning: "Workday Learning",
  linkedin_learning: "LinkedIn Learning",
  cornerstone: "Cornerstone",
  internal_doc: "Internal doc",
  video: "Video",
  link: "Link",
  other: "Other",
};

/** Select options, in the same order as the zod enum. */
export const LEARNING_PROVIDER_OPTIONS: { value: LearningProvider; label: string }[] = (
  Object.keys(LEARNING_PROVIDER_LABELS) as LearningProvider[]
).map((value) => ({ value, label: LEARNING_PROVIDER_LABELS[value] }));

/** "linkedin_learning" → "LinkedIn Learning"; anything unknown reads verbatim. */
export function providerLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return LEARNING_PROVIDER_LABELS[value as LearningProvider] ?? value.replace(/_/g, " ");
}

// ─────────────── layer ───────────────

/** A track's layer, as the admin surface labels it. */
export const LEARNING_TRACK_LAYER_LABELS: Record<LearningTrackLayer, string> = {
  organisation: "Organisation induction",
  role: "Role track",
};

/**
 * The layer tag written onto a pushed task. 'individual' is a loose resource
 * pushed at one hire with no track behind it — the per-individual layer in its
 * manual form (the derived upskilling plan is LD-2).
 */
export const LEARNING_ASSIGNMENT_LAYER_LABELS: Record<LearningAssignmentLayer, string> = {
  organisation: "About the organisation",
  role: "For your role",
  individual: "Picked for you",
};

export function assignmentLayerLabel(layer: string): string {
  return (
    LEARNING_ASSIGNMENT_LAYER_LABELS[layer as LearningAssignmentLayer] ?? layer.replace(/_/g, " ")
  );
}

export function layerTone(layer: string): BadgeTone {
  if (layer === "organisation") return "info";
  if (layer === "role") return "accent";
  return "neutral";
}

/** Display order for the hire's grouped list: org first, then role, then the
 * ad-hoc picks. Any unknown layer sorts last rather than disappearing. */
export const LEARNING_ASSIGNMENT_LAYER_ORDER: LearningAssignmentLayer[] = [
  "organisation",
  "role",
  "individual",
];

// ─────────────── duration ───────────────

/** 45 → "45 min"; 90 → "1h 30m"; 120 → "2h"; null → an em dash. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null || minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "≈4h 30m of learning" summaries — sums the known estimates, ignoring nulls. */
export function totalMinutes(items: { estimatedMinutes: number | null }[]): number {
  return items.reduce((sum, i) => sum + (i.estimatedMinutes ?? 0), 0);
}

// ─────────────── the hire's task status ───────────────

/**
 * The learning task's onboarding_tasks.status, as the hire's list labels it.
 * The value arrives as a plain string (the shared task vocabulary), so an
 * unmapped status falls back to a neutral humanised chip.
 */
const LEARNING_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: "Not started", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  completed: { label: "Marked complete", tone: "success" },
  blocked: { label: "Blocked", tone: "error" },
  skipped: { label: "Skipped", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function learningStatusMeta(status: string): { label: string; tone: BadgeTone } {
  return LEARNING_STATUS_META[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" };
}
