"use client";

import { useEffect, useState } from "react";
import {
  WELCOME_GUIDE_SECTION_LABELS,
  WELCOME_LEADERS_MAX,
  WELCOME_LINKS_MAX,
  WELCOME_SOURCE_TEXT_MAX,
  type ListWelcomeScopesOutput,
  type WelcomeGuideContent,
  type WelcomeGuideVersion,
  type WelcomeSourceFields,
} from "@hireops/api-types";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * PC-18 — Admin → Welcome content.
 *
 * Left: the organisation default + every business unit, with what each has
 * (source / draft / published version). Right: the selected scope's source
 * material, the AI draft (editable, with what the grounding check removed),
 * and the version history. Nothing reaches a candidate until a person
 * publishes; a published version is never edited in place.
 */

const input = "h-9 rounded-md border border-neutral-200 px-2 text-sm";
const area = "block w-full rounded-md border border-neutral-200 px-2 py-1 text-sm";

const EMPTY_SOURCE: WelcomeSourceFields = {
  overview: "",
  leaders: [],
  culture: "",
  firstWeek: "",
  links: [],
};

type ScopeKey = string; // "" = organisation default

function Section({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
          {hint ? <p className="mt-0.5 text-xs text-neutral-500">{hint}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </Card>
  );
}

function TextField({
  label,
  value,
  onChange,
  rows = 4,
  placeholder,
  max = WELCOME_SOURCE_TEXT_MAX,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  max?: number;
}) {
  return (
    <label className="block text-sm">
      <span className="text-neutral-700">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, max))}
        rows={rows}
        className={`${area} mt-1`}
        placeholder={placeholder}
      />
    </label>
  );
}

const STATUS_TONE = {
  draft: "warning",
  published: "success",
  superseded: "neutral",
  discarded: "neutral",
} as const;

export function WelcomeContentClient({
  initialScopes,
}: {
  initialScopes: ListWelcomeScopesOutput;
}) {
  const utils = trpc.useUtils();
  const scopes = trpc.listWelcomeScopes.useQuery({}, { initialData: initialScopes });
  const [selected, setSelected] = useState<ScopeKey>("");
  const businessUnitId = selected === "" ? null : selected;
  const content = trpc.getWelcomeContent.useQuery({ businessUnitId });

  const [source, setSource] = useState<WelcomeSourceFields>(EMPTY_SOURCE);
  const [draft, setDraft] = useState<WelcomeGuideContent | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const draftVersion: WelcomeGuideVersion | undefined = content.data?.versions.find(
    (v) => v.status === "draft",
  );

  // Re-seed local edit state only when the scope / saved row actually changes,
  // never on a background refetch (that would discard unsaved edits).
  const sourceKey = content.data
    ? `${content.data.businessUnitId ?? ""}:${content.data.sourceUpdatedAt ?? ""}`
    : null;
  const draftKey = draftVersion ? `${draftVersion.id}:${draftVersion.editedAt ?? ""}` : "";
  const loadedSource = content.data?.source;
  const loadedDraft = draftVersion?.content ?? null;
  useEffect(() => {
    if (sourceKey !== null && loadedSource) setSource(loadedSource);
  }, [sourceKey]);
  useEffect(() => {
    setDraft(loadedDraft);
  }, [draftKey, selected]);

  const refresh = () => {
    void utils.getWelcomeContent.invalidate({ businessUnitId });
    void utils.listWelcomeScopes.invalidate();
  };
  const onError = (e: unknown) => handleTRPCError(e, { onMessage: setMsg });

  const saveSource = trpc.upsertWelcomeSource.useMutation({
    onSuccess: () => {
      setMsg("Source material saved.");
      refresh();
    },
    onError,
  });
  const generate = trpc.generateWelcomeGuide.useMutation({
    onSuccess: (g) => {
      setMsg(
        g.groundingReport.dropped.length > 0
          ? `Draft version ${g.version} created. ${g.groundingReport.dropped.length} item(s) were removed because they are not in your source — see below.`
          : `Draft version ${g.version} created. Review it, then publish.`,
      );
      refresh();
    },
    onError,
  });
  const saveDraft = trpc.updateWelcomeGuideDraft.useMutation({
    onSuccess: () => {
      setMsg("Draft saved.");
      refresh();
    },
    onError,
  });
  const publish = trpc.publishWelcomeGuide.useMutation({
    onSuccess: (r) => {
      setMsg(`Version ${r.version} published. New hires now see it.`);
      refresh();
    },
    onError,
  });
  const discard = trpc.discardWelcomeGuideDraft.useMutation({
    onSuccess: () => {
      setMsg("Draft discarded.");
      refresh();
    },
    onError,
  });
  const copyToDraft = trpc.createWelcomeDraftFromVersion.useMutation({
    onSuccess: (g) => {
      setMsg(`Draft version ${g.version} created from the published text.`);
      refresh();
    },
    onError,
  });

  const scopeRows = scopes.data?.scopes ?? [];
  const generationEnabled = scopes.data?.generationEnabled ?? false;
  const busy =
    saveSource.isPending ||
    generate.isPending ||
    saveDraft.isPending ||
    publish.isPending ||
    discard.isPending ||
    copyToDraft.isPending;

  const setLeader = (i: number, patch: Partial<WelcomeSourceFields["leaders"][number]>) =>
    setSource((s) => ({
      ...s,
      leaders: s.leaders.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));
  const setLink = (i: number, patch: Partial<WelcomeSourceFields["links"][number]>) =>
    setSource((s) => ({
      ...s,
      links: s.links.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));

  return (
    <PageContainer variant="wide" className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card className="h-fit space-y-1 p-2">
        <p className="px-2 pt-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Scopes
        </p>
        {scopeRows.map((s) => {
          const key = s.businessUnitId ?? "";
          return (
            <button
              key={key || "org"}
              type="button"
              onClick={() => {
                setSelected(key);
                setMsg(null);
              }}
              className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm ${
                key === selected ? "bg-brand-50 text-brand-800" : "hover:bg-neutral-50"
              }`}
            >
              <span className={s.isArchived ? "text-neutral-400" : "font-medium"}>
                {s.name}
                {s.isArchived ? " (archived)" : ""}
              </span>
              <span className="flex flex-wrap gap-1 pt-0.5">
                {s.publishedVersion !== null ? (
                  <Badge tone="success">v{s.publishedVersion} live</Badge>
                ) : null}
                {s.hasDraft ? <Badge tone="warning">draft</Badge> : null}
                {!s.hasSource ? <Badge tone="neutral">no content</Badge> : null}
              </span>
            </button>
          );
        })}
      </Card>

      <div className="space-y-4">
        <Card className="text-sm text-neutral-600">
          New hires see the published guide for their business unit; if it has none, the nearest
          parent unit&apos;s; otherwise the organisation default. Write the facts here — the AI only
          rewrites what you provide and never adds names, facts or numbers of its own.
        </Card>
        {msg ? (
          <p className="rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-700">{msg}</p>
        ) : null}

        {!content.data ? (
          <Card>
            <EmptyState title="Loading…" />
          </Card>
        ) : (
          <>
            <Section
              title={`Source material — ${content.data.scopeName}`}
              hint="Everything the guide may say comes from here. Leaders are the only people the guide can introduce."
              actions={
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => saveSource.mutate({ businessUnitId, source })}
                >
                  Save source
                </Button>
              }
            >
              <TextField
                label="Overview — what this business unit does and how it fits in"
                value={source.overview}
                onChange={(v) => setSource({ ...source, overview: v })}
              />
              <div className="space-y-2">
                <p className="text-sm text-neutral-700">Leaders the new hire will meet</p>
                {source.leaders.map((l, i) => (
                  <div
                    key={i}
                    className="grid gap-2 rounded-md border border-neutral-100 p-2 md:grid-cols-2"
                  >
                    <input
                      className={input}
                      placeholder="Name"
                      value={l.name}
                      maxLength={120}
                      onChange={(e) => setLeader(i, { name: e.target.value })}
                    />
                    <input
                      className={input}
                      placeholder="Title"
                      value={l.title}
                      maxLength={120}
                      onChange={(e) => setLeader(i, { title: e.target.value })}
                    />
                    <textarea
                      className={`${area} md:col-span-2`}
                      rows={2}
                      placeholder="Short bio"
                      value={l.bio}
                      maxLength={600}
                      onChange={(e) => setLeader(i, { bio: e.target.value })}
                    />
                    <input
                      className={input}
                      placeholder="Photo URL (optional, https://…)"
                      value={l.photoUrl ?? ""}
                      onChange={(e) =>
                        setLeader(i, { photoUrl: e.target.value.trim() ? e.target.value : null })
                      }
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSource({
                            ...source,
                            leaders: source.leaders.filter((_, j) => j !== i),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
                {source.leaders.length < WELCOME_LEADERS_MAX ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setSource({
                        ...source,
                        leaders: [
                          ...source.leaders,
                          { name: "", title: "", bio: "", photoUrl: null },
                        ],
                      })
                    }
                  >
                    Add leader
                  </Button>
                ) : null}
              </div>
              <TextField
                label="Culture and values — how we work"
                value={source.culture}
                onChange={(v) => setSource({ ...source, culture: v })}
              />
              <TextField
                label="First week — what to expect"
                value={source.firstWeek}
                onChange={(v) => setSource({ ...source, firstWeek: v })}
              />
              <div className="space-y-2">
                <p className="text-sm text-neutral-700">Links and videos (shown as-is)</p>
                {source.links.map((l, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input
                      className={`${input} w-48`}
                      placeholder="Label"
                      value={l.label}
                      maxLength={120}
                      onChange={(e) => setLink(i, { label: e.target.value })}
                    />
                    <input
                      className={`${input} min-w-0 flex-1`}
                      placeholder="https://…"
                      value={l.url}
                      onChange={(e) => setLink(i, { url: e.target.value })}
                    />
                    <select
                      className={input}
                      value={l.kind}
                      onChange={(e) => setLink(i, { kind: e.target.value as "link" | "video" })}
                    >
                      <option value="link">Link</option>
                      <option value="video">Video</option>
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setSource({ ...source, links: source.links.filter((_, j) => j !== i) })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                {source.links.length < WELCOME_LINKS_MAX ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setSource({
                        ...source,
                        links: [...source.links, { label: "", url: "", kind: "link" }],
                      })
                    }
                  >
                    Add link
                  </Button>
                ) : null}
              </div>
            </Section>

            <Section
              title="Welcome guide draft"
              hint={
                generationEnabled
                  ? "Generate a draft from the saved source material, review and edit it, then publish. Generating again replaces the current draft."
                  : "Welcome guide generation is switched off in Admin → AI settings. Published guides stay visible to new hires."
              }
              actions={
                <Button
                  size="sm"
                  variant={draftVersion ? "secondary" : "primary"}
                  disabled={busy || !generationEnabled || !content.data.sourceUpdatedAt}
                  onClick={() => generate.mutate({ businessUnitId })}
                >
                  {generate.isPending
                    ? "Generating…"
                    : draftVersion
                      ? "Regenerate draft"
                      : "Generate welcome guide"}
                </Button>
              }
            >
              {!draftVersion || !draft ? (
                <p className="text-sm text-neutral-500">
                  No draft. {content.data.sourceUpdatedAt ? "" : "Save some source material first."}
                </p>
              ) : (
                <DraftEditor
                  version={draftVersion}
                  draft={draft}
                  setDraft={setDraft}
                  busy={busy}
                  onSave={() => saveDraft.mutate({ guideId: draftVersion.id, content: draft })}
                  onPublish={() => publish.mutate({ guideId: draftVersion.id })}
                  onDiscard={() => discard.mutate({ guideId: draftVersion.id })}
                />
              )}
            </Section>

            <Section
              title="Versions"
              hint="Every generated or edited version is kept. Only the published one is shown to new hires."
            >
              {content.data.versions.length === 0 ? (
                <p className="text-sm text-neutral-500">No versions yet.</p>
              ) : (
                <ul className="divide-y divide-neutral-100 text-sm">
                  {content.data.versions.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="font-medium">Version {v.version}</span>
                      <Badge tone={STATUS_TONE[v.status]}>{v.status}</Badge>
                      <span className="text-xs text-neutral-500">
                        {v.model ? `${v.model} · ` : ""}
                        {v.promptVersion ? `prompt ${v.promptVersion} · ` : ""}
                        {v.editedAt ? "edited by a person · " : ""}
                        {new Date(v.publishedAt ?? v.createdAt).toLocaleString()}
                      </span>
                      {(v.status === "published" || v.status === "superseded") && !draftVersion ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => copyToDraft.mutate({ guideId: v.id })}
                        >
                          Edit as new draft
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </PageContainer>
  );
}

function DraftEditor({
  version,
  draft,
  setDraft,
  busy,
  onSave,
  onPublish,
  onDiscard,
}: {
  version: WelcomeGuideVersion;
  draft: WelcomeGuideContent;
  setDraft: (d: WelcomeGuideContent) => void;
  busy: boolean;
  onSave: () => void;
  onPublish: () => void;
  onDiscard: () => void;
}) {
  const dropped = version.groundingReport.dropped;
  const dirty = JSON.stringify(draft) !== JSON.stringify(version.content);
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Version {version.version}
        {version.model ? ` · ${version.model}` : ""}
        {version.promptVersion ? ` · prompt ${version.promptVersion}` : ""}
        {version.editedAt ? " · edited by a person" : ""}
      </p>
      {dropped.length > 0 ? (
        <div className="rounded-md border border-status-warning-200 bg-status-warning-50 p-3 text-sm">
          <p className="font-medium text-neutral-900">
            Removed because it is not in your source material ({dropped.length})
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-neutral-700">
            {dropped.map((d, i) => (
              <li key={i}>
                <span className="text-xs text-neutral-500">
                  {WELCOME_GUIDE_SECTION_LABELS[d.section]}:{" "}
                </span>
                {d.reason === "person_not_in_source"
                  ? `${d.text} (not in your leader list)`
                  : d.text}
                {d.reason === "ungrounded_terms" ? (
                  <span className="text-xs text-neutral-500">
                    {" "}
                    — not in source: {d.terms.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-neutral-500">
            If any of these are right, add them to the source material and regenerate, or write them
            into the draft yourself.
          </p>
        </div>
      ) : null}
      <TextField
        label={WELCOME_GUIDE_SECTION_LABELS.welcome}
        value={draft.welcome}
        rows={3}
        max={3000}
        onChange={(v) => setDraft({ ...draft, welcome: v })}
      />
      <TextField
        label={WELCOME_GUIDE_SECTION_LABELS.business_unit}
        value={draft.businessUnit}
        onChange={(v) => setDraft({ ...draft, businessUnit: v })}
      />
      <div className="space-y-2">
        <p className="text-sm text-neutral-700">{WELCOME_GUIDE_SECTION_LABELS.people}</p>
        {draft.people.length === 0 ? (
          <p className="text-xs text-neutral-500">No one listed.</p>
        ) : null}
        {draft.people.map((p, i) => (
          <div key={i} className="rounded-md border border-neutral-100 p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {p.name}
                {p.title ? (
                  <span className="font-normal text-neutral-500"> · {p.title}</span>
                ) : null}
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft({ ...draft, people: draft.people.filter((_, j) => j !== i) })
                }
              >
                Remove
              </Button>
            </div>
            <textarea
              className={`${area} mt-1`}
              rows={2}
              maxLength={800}
              value={p.about}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  people: draft.people.map((x, j) =>
                    j === i ? { ...x, about: e.target.value } : x,
                  ),
                })
              }
            />
          </div>
        ))}
      </div>
      <TextField
        label={WELCOME_GUIDE_SECTION_LABELS.how_we_work}
        value={draft.howWeWork}
        onChange={(v) => setDraft({ ...draft, howWeWork: v })}
      />
      <TextField
        label={WELCOME_GUIDE_SECTION_LABELS.first_week}
        value={draft.firstWeek}
        onChange={(v) => setDraft({ ...draft, firstWeek: v })}
      />
      <div className="space-y-2">
        <p className="text-sm text-neutral-700">{WELCOME_GUIDE_SECTION_LABELS.faqs}</p>
        {draft.faqs.map((f, i) => (
          <div key={i} className="space-y-1 rounded-md border border-neutral-100 p-2">
            <input
              className={`${input} w-full`}
              value={f.question}
              maxLength={300}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  faqs: draft.faqs.map((x, j) =>
                    j === i ? { ...x, question: e.target.value } : x,
                  ),
                })
              }
            />
            <textarea
              className={area}
              rows={2}
              maxLength={1500}
              value={f.answer}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  faqs: draft.faqs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)),
                })
              }
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft({ ...draft, faqs: draft.faqs.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" variant="secondary" disabled={busy || !dirty} onClick={onSave}>
          Save draft
        </Button>
        <Button size="sm" disabled={busy || dirty} onClick={onPublish}>
          Publish
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard draft
        </Button>
        {dirty ? (
          <span className="self-center text-xs text-neutral-500">
            Save your edits before publishing.
          </span>
        ) : null}
      </div>
    </div>
  );
}
