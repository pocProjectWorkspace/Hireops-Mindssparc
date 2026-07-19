"use client";

import { useMemo, useState } from "react";
import { Button, Input } from "@hireops/ui";
import { Card, EmptyState } from "@/components/ui";
import { CandidatePortalShell } from "@/components/candidate/CandidatePortalShell";
import { trpc } from "@/lib/trpc-client";
import { TRPCClientError } from "@trpc/client";
import type { CandidateProfile } from "@hireops/api-types";

/** Integer paise → a readable ₹ amount (whole rupees; INR-only Wave 1). */
function formatInr(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

export function CandidateProfileClient() {
  const profileQuery = trpc.candidateGetProfile.useQuery(undefined, { retry: false });

  if (profileQuery.isLoading || (!profileQuery.data && !profileQuery.isError)) {
    return (
      <CandidatePortalShell active="profile">
        <Card className="p-6">
          <EmptyState title="Loading your profile…" />
        </Card>
      </CandidatePortalShell>
    );
  }

  if (profileQuery.isError || !profileQuery.data) {
    const forbidden =
      profileQuery.error instanceof TRPCClientError &&
      profileQuery.error.data?.code === "FORBIDDEN";
    return (
      <CandidatePortalShell active="profile">
        <Card className="p-6">
          <EmptyState
            title={forbidden ? "This isn't a candidate account" : "We couldn't load your profile"}
            hint={
              forbidden
                ? "You're signed in, but not as a candidate."
                : "Please try again in a moment."
            }
          />
        </Card>
      </CandidatePortalShell>
    );
  }

  return (
    <CandidatePortalShell active="profile">
      <ProfileForm initial={profileQuery.data.profile} />
    </CandidatePortalShell>
  );
}

// ── the editable form (seeded once from the loaded profile) ──

interface FormState {
  phone: string;
  locationCity: string;
  locationCountry: string;
  experienceSummary: string;
  educationSummary: string;
  skills: string; // comma-separated in the field
  noticePeriodDays: string;
  expectedSalaryRupees: string; // annual rupees in the field
}

function seed(p: CandidateProfile): FormState {
  return {
    phone: p.phone ?? "",
    locationCity: p.locationCity ?? "",
    locationCountry: p.locationCountry ?? "",
    experienceSummary: p.experienceSummary ?? "",
    educationSummary: p.educationSummary ?? "",
    skills: p.skills.join(", "),
    noticePeriodDays: p.noticePeriodDays != null ? String(p.noticePeriodDays) : "",
    expectedSalaryRupees:
      p.expectedSalaryInrPaise != null ? String(Math.round(p.expectedSalaryInrPaise / 100)) : "",
  };
}

function ProfileForm({ initial }: { initial: CandidateProfile }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<FormState>(() => seed(initial));
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const update = trpc.candidateUpdateProfile.useMutation({
    onSuccess: (res) => {
      setForm(seed(res.profile));
      setStatus("saved");
      setErrorMsg(null);
      void utils.candidateGetProfile.invalidate();
    },
    onError: (e) => {
      setStatus("error");
      setErrorMsg(
        e instanceof TRPCClientError && e.data?.code === "BAD_REQUEST"
          ? "Some details look off — please check and try again."
          : "Couldn't save just now. Please try again.",
      );
    },
  });

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    if (status !== "idle") setStatus("idle");
  }

  const salaryPreview = useMemo(() => {
    const n = Number(form.expectedSalaryRupees);
    if (!form.expectedSalaryRupees.trim() || !Number.isFinite(n) || n <= 0) return null;
    return formatInr(Math.round(n) * 100);
  }, [form.expectedSalaryRupees]);

  function onSave() {
    const skills = form.skills
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const noticeRaw = form.noticePeriodDays.trim();
    const noticeNum = noticeRaw ? Math.trunc(Number(noticeRaw)) : null;
    const salaryRaw = form.expectedSalaryRupees.trim();
    const salaryNum = salaryRaw ? Math.round(Number(salaryRaw)) : null;

    if (noticeRaw && (!Number.isFinite(noticeNum) || (noticeNum ?? -1) < 0)) {
      setStatus("error");
      setErrorMsg("Notice period must be a number of days.");
      return;
    }
    if (salaryRaw && (!Number.isFinite(salaryNum) || (salaryNum ?? -1) < 0)) {
      setStatus("error");
      setErrorMsg("Salary expectation must be a positive number.");
      return;
    }

    update.mutate({
      phone: form.phone.trim() || null,
      locationCity: form.locationCity.trim() || null,
      locationCountry: form.locationCountry.trim()
        ? form.locationCountry.trim().toUpperCase()
        : null,
      experienceSummary: form.experienceSummary.trim() || null,
      educationSummary: form.educationSummary.trim() || null,
      skills,
      noticePeriodDays: noticeNum,
      expectedSalaryInrPaise: salaryNum != null ? salaryNum * 100 : null,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">My Profile</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Keep these up to date — recruiters use them to move your application forward.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status === "saved" ? (
            <span className="text-sm font-medium text-status-success-700">Saved</span>
          ) : null}
          <Button
            variant="primary"
            onClick={onSave}
            loading={update.isPending}
            disabled={update.isPending}
          >
            Save Changes
          </Button>
        </div>
      </div>

      {status === "error" && errorMsg ? (
        <p
          role="alert"
          className="rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700"
        >
          {errorMsg}
        </p>
      ) : null}

      <Card className="flex flex-col gap-5 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Personal Information
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Full Name" value={initial.fullName ?? ""} readOnly disabled />
          <Input
            label="Email"
            type="email"
            value={initial.email ?? ""}
            readOnly
            disabled
            hint="Contact your recruiter to change this."
          />
          <Input
            label="Phone"
            type="tel"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            placeholder="+91 98765 43210"
          />
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Input
              label="Location (City)"
              value={form.locationCity}
              onChange={(e) => set("locationCity", e.target.value)}
              placeholder="Bengaluru"
            />
            <Input
              label="Country"
              value={form.locationCountry}
              onChange={(e) => set("locationCountry", e.target.value.toUpperCase().slice(0, 2))}
              placeholder="IN"
              maxLength={2}
              hint="2-letter"
            />
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-5 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Professional Details
        </h2>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-700">Experience Summary</span>
          <textarea
            value={form.experienceSummary}
            onChange={(e) => set("experienceSummary", e.target.value)}
            rows={3}
            placeholder="e.g. 6 years in backend engineering with Java, Spring Boot, and AWS."
            className="w-full resize-y rounded-md border border-neutral-200 px-4 py-2.5 text-base text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>

        <Input
          label="Education"
          value={form.educationSummary}
          onChange={(e) => set("educationSummary", e.target.value)}
          placeholder="e.g. B.Tech in Computer Science, IIT Delhi (2020)"
        />

        <Input
          label="Skills"
          value={form.skills}
          onChange={(e) => set("skills", e.target.value)}
          placeholder="React, TypeScript, Node.js, AWS"
          hint="Comma-separated."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Notice Period (days)"
            type="number"
            inputMode="numeric"
            value={form.noticePeriodDays}
            onChange={(e) => set("noticePeriodDays", e.target.value)}
            placeholder="30"
            min={0}
          />
          <Input
            label="Salary Expectation (₹ / year)"
            type="number"
            inputMode="numeric"
            value={form.expectedSalaryRupees}
            onChange={(e) => set("expectedSalaryRupees", e.target.value)}
            placeholder="3600000"
            min={0}
            prefix="₹"
            hint={salaryPreview ? `${salaryPreview} per year` : "Annual, in Indian rupees."}
          />
        </div>
      </Card>
    </div>
  );
}
