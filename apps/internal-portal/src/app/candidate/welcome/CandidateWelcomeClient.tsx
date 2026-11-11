"use client";

import { useEffect, useRef } from "react";
import { TRPCClientError } from "@trpc/client";
import {
  WELCOME_GUIDE_SECTION_LABELS,
  type CandidateWelcomeGuide,
  type WelcomeGuideSectionKey,
} from "@hireops/api-types";
import { Card, EmptyState } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { formatDate } from "@/components/candidate/candidate-format";
import { trpc } from "@/lib/trpc-client";

/**
 * PC-18 — the hire's welcome guide. Content is the tenant's published guide,
 * rendered as plain text (never HTML). Each section records a read receipt the
 * first time it scrolls into view (feeds "Welcome guide viewed" on the
 * recruiter's engagement timeline). Receipts are best-effort: a failure never
 * blocks reading.
 */
export function CandidateWelcomeClient() {
  const q = trpc.candidateGetMyWelcomeGuide.useQuery(undefined, { retry: false });

  const shell = (children: React.ReactNode) => (
    <CandidateShell variant="portal" active="welcome">
      <PageContainer variant="measure" className="flex flex-col gap-6">
        {children}
      </PageContainer>
    </CandidateShell>
  );

  if (q.isError) {
    const forbidden = q.error instanceof TRPCClientError && q.error.data?.code === "FORBIDDEN";
    return shell(
      <Card className="p-6">
        <EmptyState
          title={
            forbidden ? "This isn't a candidate account" : "We couldn't load your welcome guide"
          }
          hint={forbidden ? "You're signed in, but not as a candidate." : "Please try again."}
        />
      </Card>,
    );
  }
  if (!q.data) {
    return shell(
      <Card className="p-6">
        <EmptyState title="Loading…" />
      </Card>,
    );
  }
  const company = q.data.companyName || "your new team";
  if (q.data.status !== "available" || !q.data.guide) {
    return shell(
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Welcome to {company}
        </h1>
        <Card className="p-6">
          <EmptyState
            title={
              q.data.status === "not_pre_joining"
                ? "Your welcome guide appears here once you've accepted an offer"
                : "Your welcome guide isn't ready yet"
            }
            hint={
              q.data.status === "not_pre_joining"
                ? "It introduces the team you're joining before your first day."
                : "We'll email you when it is. Your recruiter can help in the meantime."
            }
          />
        </Card>
      </>,
    );
  }
  return shell(<Guide guide={q.data.guide} />);
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function Prose({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-neutral-700">
      {paragraphs(text).map((p, i) => (
        <p key={i} className="whitespace-pre-line">
          {p}
        </p>
      ))}
    </div>
  );
}

function Guide({ guide }: { guide: CandidateWelcomeGuide }) {
  const mark = trpc.candidateMarkWelcomeSectionViewed.useMutation();
  const seen = useRef(new Set<WelcomeGuideSectionKey>(guide.viewedSections));
  const refs = useRef(new Map<WelcomeGuideSectionKey, HTMLElement>());

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const key = (e.target as HTMLElement).dataset.section as WelcomeGuideSectionKey;
          if (!key || seen.current.has(key)) continue;
          seen.current.add(key);
          mark.mutate({ guideId: guide.guideId, section: key });
        }
      },
      { threshold: 0.4 },
    );
    for (const el of refs.current.values()) obs.observe(el);
    return () => obs.disconnect();
    // Re-observe only when the guide changes (mark is a stable mutation handle).
  }, [guide.guideId]);

  const sectionRef = (key: WelcomeGuideSectionKey) => (el: HTMLElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };

  const c = guide.content;
  const block = (key: WelcomeGuideSectionKey, body: React.ReactNode) =>
    guide.sections.includes(key) ? (
      <section key={key} ref={sectionRef(key)} data-section={key}>
        <Card className="space-y-3 p-6">
          <h2 className="text-lg font-semibold text-neutral-900">
            {key === "business_unit" && guide.scopeName
              ? guide.scopeName
              : WELCOME_GUIDE_SECTION_LABELS[key]}
          </h2>
          {body}
        </Card>
      </section>
    ) : null;

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Welcome to {guide.companyName}
        </h1>
        <p className="text-sm text-neutral-600">
          {guide.positionTitle ? `${guide.positionTitle} · ` : ""}
          {guide.joiningDate ? `Joining ${formatDate(guide.joiningDate)}` : ""}
        </p>
      </header>

      {block("welcome", <Prose text={c.welcome} />)}
      {block("business_unit", <Prose text={c.businessUnit} />)}
      {block(
        "people",
        <ul className="grid gap-4 sm:grid-cols-2">
          {c.people.map((p) => (
            <li key={p.name} className="flex gap-3">
              {guide.photos[p.name] ? (
                <img
                  src={guide.photos[p.name]}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700"
                >
                  {p.name.trim()[0]?.toUpperCase() ?? "?"}
                </span>
              )}
              <div>
                <p className="text-sm font-medium text-neutral-900">{p.name}</p>
                {p.title ? <p className="text-xs text-neutral-500">{p.title}</p> : null}
                {p.about ? <p className="mt-1 text-sm text-neutral-700">{p.about}</p> : null}
              </div>
            </li>
          ))}
        </ul>,
      )}
      {block("how_we_work", <Prose text={c.howWeWork} />)}
      {block("first_week", <Prose text={c.firstWeek} />)}
      {block(
        "faqs",
        <dl className="space-y-4">
          {c.faqs.map((f, i) => (
            <div key={i}>
              <dt className="text-sm font-medium text-neutral-900">{f.question}</dt>
              <dd className="mt-1 whitespace-pre-line text-sm text-neutral-700">{f.answer}</dd>
            </div>
          ))}
        </dl>,
      )}

      {guide.links.length > 0 ? (
        <Card className="space-y-2 p-6">
          <h2 className="text-lg font-semibold text-neutral-900">Links and videos</h2>
          <ul className="space-y-1 text-sm">
            {guide.links.map((l) => (
              <li key={l.url}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-700 underline"
                >
                  {l.label}
                </a>
                {l.kind === "video" ? (
                  <span className="text-xs text-neutral-500"> · video</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
