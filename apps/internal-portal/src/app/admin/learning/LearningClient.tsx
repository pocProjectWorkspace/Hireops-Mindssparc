"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type {
  LearningProvider,
  LearningResourceRow,
  LearningTrackLayer,
  LearningTrackRow,
  ListLearningResourcesOutput,
  ListLearningTracksOutput,
} from "@hireops/api-types";
import { Input, Select } from "@hireops/ui";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
} from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import {
  LEARNING_PROVIDER_OPTIONS,
  LEARNING_TRACK_LAYER_LABELS,
  formatMinutes,
  layerTone,
  providerLabel,
} from "@/components/learning/learning-format";

/**
 * Admin Learning & development (LD-1B). Two tabs, one page:
 *
 *  (A) Catalogue — `learning_resources`. A library of POINTERS at learning that
 *      already exists somewhere else. `url` is the payload; HireOps stores no
 *      media and there is no upload — hosting a video would be authoring, not
 *      orchestrating. Rows are ARCHIVED, never deleted: track items FK them and
 *      tasks already pushed at a hire must keep resolving.
 *
 *  (B) Tracks — `learning_tracks` + their ordered `learning_track_items`. A
 *      curated bundle a recruiter pushes at one hire in a single action. The
 *      header and the contents are two separate writes (upsertLearningTrack /
 *      setLearningTrackItems), so editing a name never disturbs the items.
 *
 * Nothing on this page reaches a hire by itself. The push is an explicit act of
 * intent on the onboarding case detail surface (assignLearningToCase); tracks
 * are bundles you push, not rules that fire on their own.
 */

/** Radix Select forbids "" values — sentinel for "no business unit". */
const NO_BUSINESS_UNIT = "__none__";

/** Same reason — the "nothing picked yet" value of the add-a-resource picker. */
const NO_RESOURCE = "__pick__";

const LAYER_OPTIONS: { value: LearningTrackLayer; label: string }[] = [
  { value: "organisation", label: LEARNING_TRACK_LAYER_LABELS.organisation },
  { value: "role", label: LEARNING_TRACK_LAYER_LABELS.role },
];

type Tab = "catalogue" | "tracks";

export function LearningClient({
  initialResources,
  initialTracks,
}: {
  initialResources: ListLearningResourcesOutput;
  initialTracks: ListLearningTracksOutput;
}) {
  const [tab, setTab] = useState<Tab>("catalogue");
  const [notice, setNotice] = useState<string | null>(null);

  const resourcesQuery = trpc.listLearningResources.useQuery(
    { includeArchived: true },
    { initialData: initialResources },
  );
  const tracksQuery = trpc.listLearningTracks.useQuery(
    { includeInactive: true },
    { initialData: initialTracks },
  );

  const resources = resourcesQuery.data?.rows ?? [];
  const tracks = tracksQuery.data?.rows ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Learning & development"
        subtitle="Point at learning that already exists — a Workday Learning or LinkedIn course, a SharePoint doc, an unlisted video — and bundle it into tracks a recruiter can push at one new hire."
      />

      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.includes("failed")
              ? "border-status-error-200 bg-status-error-50 text-status-error-700"
              : "border-status-success-200 bg-status-success-50 text-status-success-700"
          }`}
        >
          {notice}
        </div>
      ) : null}

      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        HireOps <span className="font-medium">orchestrates</span> learning — it assigns, sequences
        and tracks it. It does not host it: every resource is a URL pointing at your LMS, drive or
        intranet, and there is no file upload here. Nothing configured on this page reaches a hire
        until someone pushes it from an onboarding case.
      </div>

      {/* Tabs */}
      <div className="mb-5 mt-6 flex gap-1 border-b border-neutral-200">
        <TabButton active={tab === "catalogue"} onClick={() => setTab("catalogue")}>
          Catalogue ({resources.length})
        </TabButton>
        <TabButton active={tab === "tracks"} onClick={() => setTab("tracks")}>
          Tracks ({tracks.length})
        </TabButton>
      </div>

      {tab === "catalogue" ? (
        <CatalogueTab resources={resources} setNotice={setNotice} />
      ) : (
        <TracksTab tracks={tracks} resources={resources} setNotice={setNotice} />
      )}
    </PageContainer>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-brand-600 text-brand-700"
          : "border-transparent text-neutral-500 hover:text-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-[11px] font-medium text-neutral-500">{children}</span>;
}

// ═══════════════════════ (A) the resource catalogue ═══════════════════════

interface ResourceDraft {
  id?: string;
  title: string;
  description: string;
  provider: LearningProvider;
  url: string;
  externalRef: string;
  /** Text-held so the field can be cleared back to "no estimate". */
  estimatedMinutes: string;
  sortOrder: string;
}

function emptyResourceDraft(): ResourceDraft {
  return {
    title: "",
    description: "",
    provider: "link",
    url: "",
    externalRef: "",
    estimatedMinutes: "",
    sortOrder: "0",
  };
}

function toResourceDraft(r: LearningResourceRow): ResourceDraft {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    provider: r.provider,
    url: r.url,
    externalRef: r.externalRef ?? "",
    estimatedMinutes: r.estimatedMinutes == null ? "" : String(r.estimatedMinutes),
    sortOrder: String(r.sortOrder),
  };
}

/** Mirrors the server's `z.string().url()` so a bad URL is caught before the
 * round-trip. Deliberately permissive about scheme — an intranet link is fine. */
function isUrl(value: string): boolean {
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

function CatalogueTab({
  resources,
  setNotice,
}: {
  resources: LearningResourceRow[];
  setNotice: (s: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<ResourceDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = async () => {
    await utils.listLearningResources.invalidate();
    await utils.listLearningTracks.invalidate();
  };

  const upsert = trpc.upsertLearningResource.useMutation({
    onSuccess: async (res) => {
      await refresh();
      setDraft(null);
      setFormError(null);
      setNotice(`Saved “${res.row.title}”.`);
    },
    onError: (err) => {
      setFormError(err.message);
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });
  const archive = trpc.archiveLearningResource.useMutation({
    onSuccess: async (res) => {
      await refresh();
      setNotice(
        res.row.isArchived
          ? `Archived “${res.row.title}” — it stays on any hire it was already pushed to.`
          : `Restored “${res.row.title}”.`,
      );
    },
    onError: (err) => {
      setNotice(`Archive failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const busy = upsert.isPending || archive.isPending;

  function patch(p: Partial<ResourceDraft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  function save() {
    if (!draft) return;
    const title = draft.title.trim();
    const url = draft.url.trim();
    if (!title) {
      setFormError("A title is required.");
      return;
    }
    if (!isUrl(url)) {
      setFormError("Enter a full URL, including https://");
      return;
    }
    const minutes = draft.estimatedMinutes.trim();
    if (minutes && !Number.isFinite(Number(minutes))) {
      setFormError("Estimated minutes must be a number, or left blank.");
      return;
    }
    setFormError(null);
    setNotice(null);
    upsert.mutate({
      ...(draft.id ? { id: draft.id } : {}),
      title,
      description: draft.description.trim() ? draft.description.trim() : null,
      provider: draft.provider,
      url,
      externalRef: draft.externalRef.trim() ? draft.externalRef.trim() : null,
      estimatedMinutes: minutes ? Math.max(0, Math.round(Number(minutes))) : null,
      sortOrder: Number(draft.sortOrder) || 0,
    });
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Catalogue</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Every row is a link to material hosted elsewhere. Archiving retires a row from the
              pickers and from any future push; it never touches a hire who already has it.
            </p>
          </div>
          <Button
            size="sm"
            disabled={busy || draft !== null}
            onClick={() => {
              setFormError(null);
              setDraft(emptyResourceDraft());
            }}
          >
            Add resource
          </Button>
        </div>

        {resources.length === 0 ? (
          <EmptyState
            className="py-10"
            title="No learning resources yet"
            hint="Add the first link — a course, a policy doc, an induction video — and it becomes available to bundle into a track or push at one hire."
          />
        ) : (
          <div className="mt-4">
            <TableShell>
              <Thead>
                <Th>Title</Th>
                <Th>Provider</Th>
                <Th>Link</Th>
                <Th numeric>Est. time</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Thead>
              <Tbody>
                {resources.map((r) => (
                  <Tr key={r.id}>
                    <Td label="Title">
                      <span className="font-medium text-neutral-900">{r.title}</span>
                      {r.description ? (
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          {r.description}
                        </span>
                      ) : null}
                      {r.externalRef ? (
                        <span className="mt-0.5 block text-xs text-neutral-400">
                          Provider ref {r.externalRef}
                        </span>
                      ) : null}
                    </Td>
                    <Td label="Provider">{providerLabel(r.provider)}</Td>
                    <Td label="Link">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800"
                      >
                        Open
                      </a>
                    </Td>
                    <Td label="Est. time" numeric>
                      {formatMinutes(r.estimatedMinutes)}
                    </Td>
                    <Td label="Status">
                      {r.isArchived ? (
                        <Badge tone="neutral">Archived</Badge>
                      ) : (
                        <Badge tone="success">Active</Badge>
                      )}
                    </Td>
                    <Td className="lg:text-right">
                      <div className="flex gap-1.5 lg:justify-end">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setFormError(null);
                            setDraft(toResourceDraft(r));
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setNotice(null);
                            archive.mutate({ id: r.id, archived: !r.isArchived });
                          }}
                        >
                          {r.isArchived ? "Restore" : "Archive"}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
          </div>
        )}
      </Card>

      {draft ? (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-neutral-900">
            {draft.id ? "Edit resource" : "New resource"}
          </h3>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-6">
            <div className="sm:col-span-4">
              <FieldLabel>Title</FieldLabel>
              <Input
                size="sm"
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="e.g. Code of conduct — annual refresher"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Provider</FieldLabel>
              <Select
                size="sm"
                options={LEARNING_PROVIDER_OPTIONS}
                value={draft.provider}
                onValueChange={(v) => patch({ provider: v as LearningProvider })}
              />
            </div>
            <div className="sm:col-span-6">
              <FieldLabel>URL — where the material actually lives</FieldLabel>
              <Input
                size="sm"
                value={draft.url}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder="https://learning.example.com/course/1234"
              />
            </div>
            <div className="sm:col-span-6">
              <FieldLabel>Description (optional)</FieldLabel>
              <textarea
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
                rows={2}
                placeholder="What the hire gets out of it, in a line."
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Provider reference (optional)</FieldLabel>
              <Input
                size="sm"
                value={draft.externalRef}
                onChange={(e) => patch({ externalRef: e.target.value })}
                placeholder="e.g. WD-COURSE-0042"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Estimated minutes (optional)</FieldLabel>
              <Input
                size="sm"
                type="number"
                value={draft.estimatedMinutes}
                onChange={(e) => patch({ estimatedMinutes: e.target.value })}
                placeholder="45"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Sort order</FieldLabel>
              <Input
                size="sm"
                type="number"
                value={draft.sortOrder}
                onChange={(e) => patch({ sortOrder: e.target.value })}
              />
            </div>
          </div>

          <p className="mt-3 text-xs text-neutral-500">
            The provider reference is the seam for a future Workday Learning sync — it is stored,
            not yet called.
          </p>

          {formError ? <p className="mt-3 text-sm text-status-error-700">{formError}</p> : null}

          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={save}>
              {draft.id ? "Save resource" : "Create resource"}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// ═══════════════════════════ (B) the tracks ═══════════════════════════

interface TrackDraft {
  id?: string;
  name: string;
  layer: LearningTrackLayer;
  businessUnitId: string | null;
  /**
   * Preserved, never edited here: a role track may bind to a position instead
   * of a role family, but no tenant-wide position list is exposed to this
   * surface's roles, so a position binding is shown read-only and round-tripped
   * unchanged. See the note rendered next to the field.
   */
  positionId: string | null;
  roleFamily: string;
  isActive: boolean;
  sortOrder: string;
}

function emptyTrackDraft(): TrackDraft {
  return {
    name: "",
    layer: "organisation",
    businessUnitId: null,
    positionId: null,
    roleFamily: "",
    isActive: true,
    sortOrder: "0",
  };
}

function toTrackDraft(t: LearningTrackRow): TrackDraft {
  return {
    id: t.id,
    name: t.name,
    layer: t.layer,
    businessUnitId: t.businessUnitId,
    positionId: t.positionId,
    roleFamily: t.roleFamily ?? "",
    isActive: t.isActive,
    sortOrder: String(t.sortOrder),
  };
}

interface ItemDraft {
  resourceId: string;
  isRequired: boolean;
  /** Text-held so the field can be cleared back to "no due date". */
  dueOffsetDays: string;
}

function TracksTab({
  tracks,
  resources,
  setNotice,
}: {
  tracks: LearningTrackRow[];
  resources: LearningResourceRow[];
  setNotice: (s: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<TrackDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [itemsFor, setItemsFor] = useState<string | null>(null);

  // The business-unit list is readable by admin / hiring_manager / recruiter —
  // NOT hr_head. `retry: false` keeps a forbidden read quiet, and the picker
  // degrades to "every hire" rather than blocking the form.
  const buQuery = trpc.listBusinessUnits.useQuery({}, { retry: false, staleTime: 60_000 });
  const businessUnits = buQuery.data?.rows ?? [];
  const buById = new Map(businessUnits.map((b) => [b.id, b.name] as const));

  const upsert = trpc.upsertLearningTrack.useMutation({
    onSuccess: async (res) => {
      await utils.listLearningTracks.invalidate();
      setDraft(null);
      setFormError(null);
      setNotice(`Saved track “${res.row.name}”.`);
    },
    onError: (err) => {
      setFormError(err.message);
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const busy = upsert.isPending;

  function patch(p: Partial<TrackDraft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  /** Switching layer clears the bindings the other layer can't carry, so the
   * form can never hold a shape the DB CHECK would reject. */
  function setLayer(layer: LearningTrackLayer) {
    if (layer === "organisation") {
      patch({ layer, positionId: null, roleFamily: "" });
    } else {
      patch({ layer, businessUnitId: null });
    }
  }

  function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setFormError("A track name is required.");
      return;
    }
    const roleFamily = draft.roleFamily.trim();
    // Mirror learning_tracks_binding_check: a role track binds to EXACTLY ONE
    // of position / role family; an organisation track to neither.
    if (draft.layer === "role" && !draft.positionId && !roleFamily) {
      setFormError("A role track must name the role family it applies to.");
      return;
    }
    if (draft.layer === "role" && draft.positionId && roleFamily) {
      setFormError("A role track binds to exactly one of a position or a role family, not both.");
      return;
    }
    setFormError(null);
    setNotice(null);
    upsert.mutate({
      ...(draft.id ? { id: draft.id } : {}),
      name,
      layer: draft.layer,
      businessUnitId: draft.layer === "organisation" ? draft.businessUnitId : null,
      positionId: draft.layer === "role" ? draft.positionId : null,
      roleFamily: draft.layer === "role" && !draft.positionId ? roleFamily : null,
      isActive: draft.isActive,
      sortOrder: Number(draft.sortOrder) || 0,
    });
  }

  const buOptions = [
    { value: NO_BUSINESS_UNIT, label: "Every hire (org-wide)" },
    ...businessUnits.map((b) => ({ value: b.id, label: b.name })),
    // A track already scoped to a unit whose name this role can't read still
    // needs an option to sit on, else the trigger renders blank.
    ...(draft?.businessUnitId && !buById.has(draft.businessUnitId)
      ? [{ value: draft.businessUnitId, label: "One business unit (name unavailable)" }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Tracks</h2>
            <p className="mt-1 text-sm text-neutral-500">
              A curated bundle a recruiter pushes at one hire in a single action. Organisation
              tracks are the induction everyone gets; role tracks belong to a role family.
            </p>
          </div>
          <Button
            size="sm"
            disabled={busy || draft !== null}
            onClick={() => {
              setFormError(null);
              setDraft(emptyTrackDraft());
            }}
          >
            Add track
          </Button>
        </div>

        {tracks.length === 0 ? (
          <EmptyState
            className="py-10"
            title="No learning tracks yet"
            hint="Create a track, add catalogue resources to it in order, and a recruiter can then push the whole bundle at a new hire from their onboarding case."
          />
        ) : (
          <div className="mt-4 space-y-3">
            {tracks.map((t) => (
              <div key={t.id} className="rounded-lg border border-neutral-200 bg-neutral-50/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-neutral-900">{t.name}</span>
                      <Badge tone={layerTone(t.layer)}>
                        {LEARNING_TRACK_LAYER_LABELS[t.layer]}
                      </Badge>
                      {t.isActive ? null : <Badge tone="neutral">Inactive</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">
                      {trackBindingLabel(t, buById)} · {t.items.length}{" "}
                      {t.items.length === 1 ? "item" : "items"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setFormError(null);
                        setDraft(toTrackDraft(t));
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setItemsFor(itemsFor === t.id ? null : t.id)}
                    >
                      {itemsFor === t.id ? "Close items" : "Edit items"}
                    </Button>
                  </div>
                </div>

                {t.items.length > 0 ? (
                  <ol className="mt-3 space-y-1 border-t border-neutral-200 pt-3">
                    {t.items.map((item, idx) => (
                      <li
                        key={item.resourceId}
                        className="flex flex-wrap items-center gap-2 text-xs text-neutral-600"
                      >
                        <span className="tabular-nums text-neutral-400">{idx + 1}.</span>
                        <span className="font-medium text-neutral-800">{item.resourceTitle}</span>
                        <span className="text-neutral-400">
                          {providerLabel(item.resourceProvider)}
                        </span>
                        {item.isRequired ? <Badge tone="accent">Required</Badge> : null}
                        {item.dueOffsetDays == null ? null : (
                          <span className="text-neutral-500">
                            due day {item.dueOffsetDays} after start
                          </span>
                        )}
                        {item.resourceIsArchived ? <Badge tone="warning">Archived</Badge> : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-3 border-t border-neutral-200 pt-3 text-xs text-neutral-500">
                    No items yet — this track would push nothing.
                  </p>
                )}

                {itemsFor === t.id ? (
                  <TrackItemsEditor
                    track={t}
                    resources={resources}
                    setNotice={setNotice}
                    onDone={() => setItemsFor(null)}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      {draft ? (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-neutral-900">
            {draft.id ? "Edit track" : "New track"}
          </h3>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-6">
            <div className="sm:col-span-4">
              <FieldLabel>Name</FieldLabel>
              <Input
                size="sm"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="e.g. Day-one induction"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Layer</FieldLabel>
              <Select
                size="sm"
                options={LAYER_OPTIONS}
                value={draft.layer}
                onValueChange={(v) => setLayer(v as LearningTrackLayer)}
              />
            </div>

            {draft.layer === "organisation" ? (
              <div className="sm:col-span-4">
                <FieldLabel>Applies to</FieldLabel>
                <Select
                  size="sm"
                  options={buOptions}
                  value={draft.businessUnitId ?? NO_BUSINESS_UNIT}
                  disabled={buQuery.isError}
                  onValueChange={(v) =>
                    patch({ businessUnitId: v === NO_BUSINESS_UNIT ? null : v })
                  }
                />
                {buQuery.isError ? (
                  <p className="mt-1 text-xs text-neutral-500">
                    Your role can&apos;t read the business-unit list, so this track stays org-wide.
                  </p>
                ) : null}
              </div>
            ) : draft.positionId ? (
              <div className="sm:col-span-4">
                <FieldLabel>Bound to a position</FieldLabel>
                <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-600">
                  {draft.positionId}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  Set outside this screen. There is no position picker here yet, so the binding is
                  shown read-only and kept as-is.
                </p>
              </div>
            ) : (
              <div className="sm:col-span-4">
                <FieldLabel>Role family</FieldLabel>
                <Input
                  size="sm"
                  value={draft.roleFamily}
                  onChange={(e) => patch({ roleFamily: e.target.value })}
                  placeholder="e.g. engineering"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  The same vocabulary as the JD library&apos;s role family. A role track binds to
                  exactly one of a role family or a position.
                </p>
              </div>
            )}

            <div className="sm:col-span-1">
              <FieldLabel>Sort order</FieldLabel>
              <Input
                size="sm"
                type="number"
                value={draft.sortOrder}
                onChange={(e) => patch({ sortOrder: e.target.value })}
              />
            </div>
            <div className="flex items-end sm:col-span-1">
              <label className="flex items-center gap-2 pb-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => patch({ isActive: e.target.checked })}
                  className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                />
                Active
              </label>
            </div>
          </div>

          {formError ? <p className="mt-3 text-sm text-status-error-700">{formError}</p> : null}

          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={save}>
              {draft.id ? "Save track" : "Create track"}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/** "Every hire (org-wide)" / "Engineering" / "Role family: engineering". */
function trackBindingLabel(t: LearningTrackRow, buById: Map<string, string>): string {
  if (t.layer === "organisation") {
    if (!t.businessUnitId) return "Every hire (org-wide)";
    return buById.get(t.businessUnitId) ?? "One business unit";
  }
  if (t.roleFamily) return `Role family: ${t.roleFamily}`;
  if (t.positionId) return "Bound to one position";
  return "Unbound";
}

/**
 * The ordered contents of ONE track. setLearningTrackItems is a whole-list
 * replace (the round-template shape) — the array order IS the sort order, and
 * saving an empty list clears the track. Archived resources are hidden from the
 * "add" picker but kept visible in the list, so an existing item is never
 * silently dropped by a save.
 */
function TrackItemsEditor({
  track,
  resources,
  setNotice,
  onDone,
}: {
  track: LearningTrackRow;
  resources: LearningResourceRow[];
  setNotice: (s: string | null) => void;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const [items, setItems] = useState<ItemDraft[]>(
    track.items.map((i) => ({
      resourceId: i.resourceId,
      isRequired: i.isRequired,
      dueOffsetDays: i.dueOffsetDays == null ? "" : String(i.dueOffsetDays),
    })),
  );
  const [addId, setAddId] = useState<string>(NO_RESOURCE);

  const titleById = new Map<string, string>([
    ...resources.map((r) => [r.id, r.title] as const),
    ...track.items.map((i) => [i.resourceId, i.resourceTitle] as const),
  ]);

  const save = trpc.setLearningTrackItems.useMutation({
    onSuccess: async (res) => {
      await utils.listLearningTracks.invalidate();
      setNotice(
        `Saved ${res.row.items.length} item${res.row.items.length === 1 ? "" : "s"} on “${res.row.name}”.`,
      );
      onDone();
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const chosen = new Set(items.map((i) => i.resourceId));
  const available = resources.filter((r) => !r.isArchived && !chosen.has(r.id));
  const addOptions = [
    {
      value: NO_RESOURCE,
      label: available.length === 0 ? "Nothing left to add" : "Pick a resource…",
    },
    ...available.map((r) => ({ value: r.id, label: r.title })),
  ];

  function move(idx: number, delta: number) {
    setItems((cur) => {
      const next = [...cur];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return cur;
      const [row] = next.splice(idx, 1);
      if (!row) return cur;
      next.splice(target, 0, row);
      return next;
    });
  }

  return (
    <div className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
        Track contents
      </h4>
      <p className="mt-1 text-xs text-neutral-500">
        Order is the order the hire sees. Due day is counted from their expected start date; leave
        it blank for no due date. Saving replaces the whole list.
      </p>

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">
          No items. Add one below, or save an empty list to clear the track.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item, idx) => (
            <li
              key={item.resourceId}
              className="grid grid-cols-12 items-center gap-2 rounded-md border border-neutral-200 px-3 py-2"
            >
              <span className="col-span-12 text-sm text-neutral-800 sm:col-span-5">
                <span className="tabular-nums text-neutral-400">{idx + 1}. </span>
                {titleById.get(item.resourceId) ?? item.resourceId}
              </span>
              <label className="col-span-5 flex items-center gap-2 text-xs text-neutral-600 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={item.isRequired}
                  onChange={(e) =>
                    setItems((cur) =>
                      cur.map((c, i) => (i === idx ? { ...c, isRequired: e.target.checked } : c)),
                    )
                  }
                  className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                />
                Required
              </label>
              <div className="col-span-7 sm:col-span-3">
                <Input
                  size="sm"
                  type="number"
                  value={item.dueOffsetDays}
                  placeholder="Due day (blank = none)"
                  onChange={(e) =>
                    setItems((cur) =>
                      cur.map((c, i) => (i === idx ? { ...c, dueOffsetDays: e.target.value } : c)),
                    )
                  }
                />
              </div>
              <div className="col-span-12 flex justify-end gap-1 sm:col-span-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => move(idx, 1)}
                  disabled={idx === items.length - 1}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setItems((cur) => cur.filter((_, i) => i !== idx))}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <FieldLabel>Add a catalogue resource</FieldLabel>
          <Select
            size="sm"
            options={addOptions}
            // Sentinel rather than "" — Radix forbids an empty value, and a
            // controlled-to-uncontrolled flip (undefined → id) would warn.
            value={addId}
            disabled={available.length === 0}
            onValueChange={(v) => setAddId(v)}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={addId === NO_RESOURCE}
          onClick={() => {
            if (addId === NO_RESOURCE) return;
            setItems((cur) => [...cur, { resourceId: addId, isRequired: true, dueOffsetDays: "" }]);
            setAddId(NO_RESOURCE);
          }}
        >
          Add
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            setNotice(null);
            save.mutate({
              trackId: track.id,
              items: items.map((i) => ({
                resourceId: i.resourceId,
                isRequired: i.isRequired,
                dueOffsetDays: i.dueOffsetDays.trim()
                  ? Math.max(0, Math.round(Number(i.dueOffsetDays)))
                  : null,
              })),
            });
          }}
        >
          Save contents
        </Button>
      </div>
    </div>
  );
}
