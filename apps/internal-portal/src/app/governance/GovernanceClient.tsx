"use client";

import { useMemo, useState } from "react";
import type { ScreeningPrivacy, FeedbackSharing } from "@hireops/api-types";
import { Switch, Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * HRHEAD-03 — the two governance settings blocks.
 *
 * screeningPrivacy: per-field anonymisation during screening. Consumed for
 * real by the triage list + candidate drawer (a recruiter sees "Candidate
 * #ID" and/or nulled contact until the candidate reaches the tech-interview
 * stage). We hold no photo / gender / age / university, so those "toggles"
 * are stated as honestly-absent rather than shown dead.
 *
 * feedbackSharing: what a candidate sees of submitted interview feedback in
 * their own portal. Numeric scores are NEVER shared regardless of the toggles.
 *
 * Each block saves as its own sibling-block mutation.
 */
export function GovernanceClient({
  initialScreeningPrivacy,
  initialFeedbackSharing,
}: {
  initialScreeningPrivacy: ScreeningPrivacy;
  initialFeedbackSharing: FeedbackSharing;
}) {
  return (
    <div className="space-y-8">
      <ApprovalNote />
      <ScreeningPrivacyCard initial={initialScreeningPrivacy} />
      <FeedbackSharingCard initial={initialFeedbackSharing} />
    </div>
  );
}

function ApprovalNote() {
  return (
    <div className="rounded-lg border border-status-info-200 bg-status-info-50 px-4 py-3 text-xs text-status-info-700">
      In production these changes route through an administrator for approval. For this POC an HR
      head edit takes effect immediately — the approval step is not yet wired.
    </div>
  );
}

function Notice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  const failed = notice.startsWith("Save failed");
  return (
    <div
      className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
        failed
          ? "border-status-error-200 bg-status-error-50 text-status-error-700"
          : "border-status-success-200 bg-status-success-50 text-status-success-700"
      }`}
    >
      {notice}
    </div>
  );
}

function ScreeningPrivacyCard({ initial }: { initial: ScreeningPrivacy }) {
  const [value, setValue] = useState<ScreeningPrivacy>(initial);
  const [saved, setSaved] = useState<ScreeningPrivacy>(initial);
  const [notice, setNotice] = useState<string | null>(null);

  const update = trpc.updateScreeningPrivacy.useMutation({
    onSuccess: (res) => {
      setValue(res.screeningPrivacy);
      setSaved(res.screeningPrivacy);
      setNotice("Saved. Triage reads apply this immediately.");
    },
    onError: (err) => setNotice(`Save failed: ${err.message}`),
  });

  const dirty = useMemo(() => JSON.stringify(value) !== JSON.stringify(saved), [value, saved]);
  const anyOn = value.hideCandidateName || value.hideContactInfo;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-base font-semibold text-neutral-900">
          Bias Shield — screening privacy
        </h2>
        {anyOn ? <Badge tone="info">Active</Badge> : null}
      </div>
      <p className="mb-4 max-w-prose text-sm text-neutral-600">
        Anonymise candidates for recruiters during early screening. Masking lifts once a candidate
        reaches the technical-interview stage, where the accountable conversation needs the real
        person. HR head and administrators always see the unmasked record.
      </p>
      <Notice notice={notice} />

      <Card className="p-5">
        <ToggleRow
          title="Hide candidate name"
          description='Recruiters see "Candidate #ID" instead of the name until the technical-interview stage.'
          checked={value.hideCandidateName}
          onChange={(c) => setValue((v) => ({ ...v, hideCandidateName: c }))}
        />
        <hr className="my-4 border-neutral-100" />
        <ToggleRow
          title="Hide contact information"
          description="Email and phone are withheld from recruiters until the technical-interview stage."
          checked={value.hideContactInfo}
          onChange={(c) => setValue((v) => ({ ...v, hideContactInfo: c }))}
        />
      </Card>

      <p className="mt-3 max-w-prose text-xs text-neutral-500">
        Photo, gender, age and university anonymisation are not offered because HireOps does not
        collect those fields — there is nothing to hide. This is a deliberate design choice, not a
        gap: no demographic data is captured or inferred anywhere in the product.
      </p>

      <SaveRow
        dirty={dirty}
        pending={update.isPending}
        onSave={() => update.mutate(value)}
        onDiscard={() => {
          setValue(saved);
          setNotice(null);
        }}
      />
    </section>
  );
}

function FeedbackSharingCard({ initial }: { initial: FeedbackSharing }) {
  const [value, setValue] = useState<FeedbackSharing>(initial);
  const [saved, setSaved] = useState<FeedbackSharing>(initial);
  const [notice, setNotice] = useState<string | null>(null);

  const update = trpc.updateFeedbackSharing.useMutation({
    onSuccess: (res) => {
      setValue(res.feedbackSharing);
      setSaved(res.feedbackSharing);
      setNotice("Saved. The candidate portal applies this immediately.");
    },
    onError: (err) => setNotice(`Save failed: ${err.message}`),
  });

  const dirty = useMemo(() => JSON.stringify(value) !== JSON.stringify(saved), [value, saved]);
  const anyOn = value.shareInterviewSummary || value.shareRecommendation;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-base font-semibold text-neutral-900">Shareable feedback policy</h2>
        {anyOn ? <Badge tone="info">Sharing on</Badge> : null}
      </div>
      <p className="mb-4 max-w-prose text-sm text-neutral-600">
        Control what a candidate sees of submitted interview feedback in their own portal, on
        completed rounds only. Numeric scores are never shared under any setting.
      </p>
      <Notice notice={notice} />

      <Card className="p-5">
        <ToggleRow
          title="Share interview summary"
          description="Candidates see the panel's strengths summary for completed interviews."
          checked={value.shareInterviewSummary}
          onChange={(c) => setValue((v) => ({ ...v, shareInterviewSummary: c }))}
        />
        <hr className="my-4 border-neutral-100" />
        <ToggleRow
          title="Share recommendation"
          description="Candidates see the roll-up recommendation (e.g. proceed / hold). Scores stay private."
          checked={value.shareRecommendation}
          onChange={(c) => setValue((v) => ({ ...v, shareRecommendation: c }))}
        />
      </Card>

      <SaveRow
        dirty={dirty}
        pending={update.isPending}
        onSave={() => update.mutate(value)}
        onDiscard={() => {
          setValue(saved);
          setNotice(null);
        }}
      />
    </section>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-neutral-900">{title}</p>
        <p className="mt-0.5 text-xs text-neutral-600">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={checked ? "On" : "Off"} />
    </div>
  );
}

function SaveRow({
  dirty,
  pending,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button onClick={onSave} disabled={!dirty || pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      {dirty ? (
        <button
          type="button"
          className="text-sm text-neutral-600 hover:underline"
          onClick={onDiscard}
        >
          Discard changes
        </button>
      ) : null}
    </div>
  );
}
