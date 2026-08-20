# HireOps — implementation checklist

**Audience:** client project sponsor + IT/security/HR counterparts.
**Purpose:** everything HireOps needs *from you* to stand up your tenant, in the order we need it.
**Version:** 1.0 · 18 August 2026

---

## How to use this

Each item has an **owner**, a **due-by phase**, and a **blocking** flag. Items marked
**🔴 BLOCKING** stop the build if they are not settled — they are decisions we cannot make on
your behalf, or credentials we cannot self-serve.

| Phase | Meaning |
|---|---|
| **P0 — Contracting** | Needed before design starts; several change the architecture |
| **P1 — Foundation** | Needed to build your tenant |
| **P2 — Configuration** | Needed to make the platform behave like your organisation |
| **P3 — Data** | Needed to migrate your existing content |
| **P4 — Integration** | Needed to connect your other systems |
| **P5 — Cutover** | Needed to go live |

A blank "Client response" column is left on each table deliberately — please fill it in place
and return the document.

---

## 1. Commercial & compliance foundations (P0)

| # | Item | Why we need it | Blocking | Client response |
|---|---|---|---|---|
| 1.1 | **Data residency** — which country/region must data physically reside in? | Determines hosting region for database, storage and backups. **Changing it later is a re-platform, not a config change.** | 🔴 | |
| 1.2 | **Regulatory regime** — DPDPA (India), GDPR (EU), other? | Drives consent wording, retention defaults, subject-rights workflows and lawful basis | 🔴 | |
| 1.3 | **Certification requirements** — SOC 2, ISO 27001, client-specific security questionnaire? | Materially affects timeline and cost | 🔴 | |
| 1.4 | **Sub-processor approval** — we use Supabase, Vercel, Fly.io, Resend, Sentry, and your chosen AI provider(s). Confirm each is acceptable to your procurement/security team | Any rejection requires re-architecture of that component | 🔴 | |
| 1.5 | **Data retention periods** per document category (CVs, offers, ID proofs, BGV reports, interview records) | Configured per category in the platform; also drives storage cost | 🔴 | |
| 1.6 | **Data Processing Agreement** signed, and your DPO/privacy contact named | Legal prerequisite | 🔴 | |
| 1.7 | **Right-to-erasure process owner** — who approves a candidate deletion request? | The platform implements erasure; you own the decision | | |
| 1.8 | Required uptime SLA and support hours | Determines DR architecture and on-call staffing | | |

---

## 2. Identity & authentication (P1)

> **Current state, stated plainly:** HireOps authenticates via Supabase Auth
> (email/password) with role-based access. **SSO/SAML and SCIM are not built today.** If you
> require either, it is a scoped work package — flag it at 2.1 and we will size it.

| # | Item | Detail needed | Blocking | Client response |
|---|---|---|---|---|
| 2.1 | **Authentication method** | Email/password (available now) · SAML 2.0 SSO · OIDC SSO · Which? | 🔴 | |
| 2.2 | **Identity provider** | Microsoft Entra ID / Okta / Google Workspace / Ping / other + version | 🔴 if SSO | |
| 2.3 | **SSO metadata** | IdP metadata XML or discovery URL, signing certificate, entity ID | 🔴 if SSO | |
| 2.4 | **User provisioning model** | Manual invite · bulk CSV · SCIM auto-provisioning · JIT on first login | 🔴 | |
| 2.5 | **De-provisioning trigger** | How we learn a user has left (SCIM deprovision, HRIS feed, manual) | 🔴 | |
| 2.6 | **MFA policy** | Enforced at IdP, or required of us? | | |
| 2.7 | **Session timeout / re-auth** | Idle timeout, absolute session lifetime | | |
| 2.8 | **Role mapping** | Map your job titles/AD groups onto our roles (§2.9) | 🔴 | |
| 2.9 | **Break-glass admin** | Named emergency admin(s) not dependent on SSO | 🔴 if SSO | |
| 2.10 | **External user access** | Partner/agency users and candidates authenticate separately — confirm this is acceptable to security | | |

**Platform roles to map against:** `admin`, `hr_head`, `hr_ops`, `recruiter`,
`hiring_manager` / requirement owner, `interview_panel`, `partner_user`, `partner_admin`,
`candidate`.

---

## 3. Organisation structure & configuration (P2)

| # | Item | Format | Blocking | Client response |
|---|---|---|---|---|
| 3.1 | **Business units / departments** hierarchy | CSV — code, name, parent, cost centre | 🔴 | |
| 3.2 | **Locations** | List of hiring locations *(note: currently free text on the position record, not a managed list)* | | |
| 3.3 | **Job families / levels / grades** | CSV | | |
| 3.4 | **Compensation bands** per role/level/location | CSV — role, level, location, min, mid, max, currency | 🔴 for offer module | |
| 3.5 | **Approval matrix** | Who approves a requisition, at what value/level, in what order, with escalation | 🔴 | |
| 3.6 | **Hiring stages** | Confirm our default pipeline or supply yours | 🔴 | |
| 3.7 | **SLA thresholds** per stage | Days allowed per stage before breach | | |
| 3.8 | **Interview round templates** | Round names, durations, panel composition, scorecard criteria | | |
| 3.9 | **Panel pools** | Who can interview for what | | |
| 3.10 | **Sourcing channels** | Your channel list for source-mix reporting | | |
| 3.11 | **Document types + retention** | Which documents are mandatory at which stage, retained how long | 🔴 | |
| 3.12 | **Onboarding task templates** | Standard task list, owners, due offsets | | |
| 3.13 | **Offboarding task templates** | Including asset return and settlement steps | | |
| 3.14 | **Headcount plan / envelopes** | Approved headcount per BU per period, for plan-vs-actual reporting | | |
| 3.15 | **Notice periods & probation** | For onboarding/offboarding date maths | | |

---

## 4. Branding & communications (P2)

| # | Item | Detail | Blocking | Client response |
|---|---|---|---|---|
| 4.1 | **Logo** | SVG or PNG ≥512px, light + dark variants | | |
| 4.2 | **Brand colours** | Primary/accent hex values | | |
| 4.3 | **Sending domain** | e.g. `careers.yourcompany.com` | 🔴 | |
| 4.4 | **DNS records** | SPF, DKIM, DMARC — **you must add these; email will not deliver otherwise** | 🔴 | |
| 4.5 | **From name / reply-to** | Per email category if they differ | 🔴 | |
| 4.6 | **Email footer & legal text** | Privacy notice, unsubscribe, company registration | 🔴 | |
| 4.7 | **Email template copy review** | 17 templates — approve or supply your wording | | |
| 4.8 | **Careers site domain** | If candidate-facing pages are hosted for you | | |
| 4.9 | **Tone/language** | Locale, date format, currency | | |

---

## 5. Data migration (P3)

For each object we need: **a populated template, a source-system export, and a nominated data
owner** who can adjudicate quality questions. We supply the template; you supply the content.

| # | Object | Template columns (minimum) | Priority | Client response |
|---|---|---|---|---|
| 5.1 | **Users & roles** | email, full name, employee id, role, business unit, manager email, active | 🔴 P1 | |
| 5.2 | **Business units** | code, name, parent code, cost centre | 🔴 P1 | |
| 5.3 | **Job descriptions / JD library** | title, family, level, BU, description, responsibilities, must-have skills, nice-to-have skills, experience range, education, location, employment type | 🔴 P1 | |
| 5.4 | **Open requisitions** | req id, title, JD ref, BU, hiring manager, recruiter, openings, target date, status, approval state, comp band | 🔴 P1 | |
| 5.5 | **Active candidates** | name, email, phone, current employer, current title, experience years, location, source, consent status + date | 🔴 P1 | |
| 5.6 | **Active applications** | candidate ref, req ref, current stage, applied date, stage-entry date, owner, disposition | 🔴 P1 | |
| 5.7 | **Candidate documents** | candidate ref, document type, file, upload date | P2 | |
| 5.8 | **Interview history** | application ref, round, date, panel, outcome, feedback | P2 | |
| 5.9 | **Offers** | application ref, status, comp breakdown, dates | P2 | |
| 5.10 | **Compensation bands** | see 3.4 | 🔴 P1 | |
| 5.11 | **Partner/agency orgs** | name, contact, status, commercial terms, exclusivity, holdback | P2 | |
| 5.12 | **Historical closed applications** | For analytics baselines only | P3 | |

**Migration decisions we need from you — 🔴 all blocking:**

| # | Decision |
|---|---|
| 5.13 | **How far back?** Historical data materially affects migration effort and storage. |
| 5.14 | **Consent basis for migrated candidates.** Do you hold valid consent to continue processing them under the new system? *This is a legal question, not a technical one, and we cannot answer it for you.* |
| 5.15 | **Deduplication rule.** When two records look like the same person, which wins — most recent, most complete, or manual review? |
| 5.16 | **Source of truth during parallel run.** If both systems are live, which one wins on conflict? |
| 5.17 | **Migration sign-off owner.** Who confirms the migrated data is correct? |

---

## 6. Integrations (P4)

### 6.1 Workday

> **Current state:** the credential vault reserves an HRMS/Workday integration type, but
> **`packages/workday-client` is an empty stub — no integration is built.** This is a scoped
> work package. The questions below determine its size, and we cannot estimate without them.

| # | Question | Blocking | Client response |
|---|---|---|---|
| 6.1.1 | **Which direction(s)?** HireOps→Workday, Workday→HireOps, or bi-directional | 🔴 | |
| 6.1.2 | **Which use cases?** Tick all: ☐ push new hire to Workday on offer accept ☐ pull worker/employee master ☐ pull org structure & cost centres ☐ pull position/requisition data ☐ push onboarding status ☐ pull termination events for offboarding ☐ pull post-hire performance for quality-of-hire reporting | 🔴 | |
| 6.1.3 | **Which is the system of record** for requisitions? For headcount/positions? | 🔴 | |
| 6.1.4 | **Integration mechanism** — Workday REST/SOAP API, RaaS report, EIB batch, or middleware (MuleSoft/Boomi/Workato)? | 🔴 | |
| 6.1.5 | **Sync frequency** — real-time/event-driven, hourly, nightly? | 🔴 | |
| 6.1.6 | **Field-level mapping** — signed-off mapping document per object | 🔴 | |
| 6.1.7 | **Sandbox access** — Workday sandbox tenant, ISU credentials, security group | 🔴 | |
| 6.1.8 | **Workday integration partner** — who on your side owns the Workday configuration? | 🔴 | |
| 6.1.9 | **Error handling** — who is notified and who reconciles on sync failure? | | |
| 6.1.10 | **Volume** — expected records per sync | | |

### 6.2 Other integrations

| # | Integration | Questions | Client response |
|---|---|---|---|
| 6.2.1 | **Calendar** (Google / Outlook) | Which? Tenant-wide service account or per-user OAuth? Consent to create events on interviewer calendars? | |
| 6.2.2 | **Video conferencing** (Zoom / Teams) | Which? Auto-generate meeting links? Required for the notetaker if adopted | |
| 6.2.3 | **Background verification** | Which vendor? API available? What checks per role? Who consumes the result? | |
| 6.2.4 | **E-signature** (Adobe Sign / DocuSign) | Which? Existing account? Which documents require it? | |
| 6.2.5 | **Job boards / sourcing** | Which boards must we post to or receive applications from? | |
| 6.2.6 | **Payroll / finance** | Needed for offboarding final settlement? | |
| 6.2.7 | **IT service management** (ServiceNow/Jira) | For onboarding IT provisioning tickets | |
| 6.2.8 | **SIEM / log forwarding** | Does security require audit logs forwarded to your SIEM? | |

---

## 7. AI configuration (P2)

> Every AI feature is independently switchable per tenant, with a model allowlist, cost logging
> and an optional monthly budget with threshold alerts. **Note:** budget alerting notifies; it
> does **not** hard-block AI calls at 100%.

| # | Decision | Options | Blocking | Client response |
|---|---|---|---|---|
| 7.1 | **AI provider** | Anthropic · OpenAI · both | 🔴 | |
| 7.2 | **Bring-your-own API key?** | Your key (AI billed to you directly) or ours (billed through us) | 🔴 | |
| 7.3 | **Which of the 11 AI features to enable** | Candidate scoring · JD generation · JD bias review · requisition feasibility · compensation rationale · feedback summary · interview prep · requisition revision · recruiter brief · agent message drafts · Iris assistant | 🔴 | |
| 7.4 | **Monthly AI budget + alert thresholds** | USD amount, alert % marks, recipients | | |
| 7.5 | **AI in candidate-affecting decisions** | Confirm your position: scoring is advisory and never auto-rejects. Some jurisdictions require disclosure of automated processing | 🔴 | |
| 7.6 | **Candidate-facing AI disclosure wording** | Your legal team's approved text | | |
| 7.7 | **Data-processing stance** | Confirm acceptance that CV/interview text is sent to your chosen AI provider | 🔴 | |
| 7.8 | **Interview notetaker in scope?** | If yes: see §8 — additional consent and per-minute vendor cost | 🔴 | |

---

## 8. Interview notetaker — additional requirements (P4, if in scope)

> Not yet built. If adopted, these are prerequisites, and several are legal rather than technical.

| # | Item | Blocking | Client response |
|---|---|---|---|
| 8.1 | **Jurisdictions where interviews are recorded** — one-party vs two-party consent regimes differ | 🔴 | |
| 8.2 | **Candidate consent wording**, legally approved | 🔴 | |
| 8.3 | **Interviewer notification stance** — we disclose to panellists and show a recording indicator; confirm this satisfies your counsel | 🔴 | |
| 8.4 | **Audio retention period** (separate from transcript retention) | 🔴 | |
| 8.5 | **Who may access recordings/transcripts** — role list | 🔴 | |
| 8.6 | **ASR vendor approval** — an additional sub-processor receiving interview audio | 🔴 | |
| 8.7 | **Expected recorded interviews/month** — per-minute billing driver | | |
| 8.8 | **Behaviour when consent is refused** — our default is: no consent, no recording, interview proceeds normally | | |

---

## 9. Environments, access & cutover (P5)

| # | Item | Blocking | Client response |
|---|---|---|---|
| 9.1 | **Environments required** — production, staging, UAT? Each has a cost | 🔴 | |
| 9.2 | **UAT participants** — named users per persona (min. one per role) | 🔴 | |
| 9.3 | **UAT sign-off criteria & owner** | 🔴 | |
| 9.4 | **Allow-listing** — does your network require IP allow-listing for our domains? | | |
| 9.5 | **Email deliverability test** — confirm our mail reaches your inboxes, not quarantine | 🔴 | |
| 9.6 | **Go-live date + freeze windows** | 🔴 | |
| 9.7 | **Parallel run period** — how long will the incumbent system stay live? | 🔴 | |
| 9.8 | **Cutover owner** on your side | 🔴 | |
| 9.9 | **Training** — who delivers it, how many sessions, which personas | | |
| 9.10 | **Support model** — L1 with you or us? Escalation path and hours | 🔴 | |
| 9.11 | **Rollback criteria** — what would make us revert, and who decides | | |

---

## 10. Summary — the ten things we need first

If nothing else moves, these ten unblock the most work:

1. Data residency (1.1)
2. Regulatory regime + certification requirements (1.2, 1.3)
3. Sub-processor approval (1.4)
4. Authentication method — and whether SSO is required (2.1)
5. Role mapping (2.8)
6. Business units + approval matrix (3.1, 3.5)
7. Document types + retention periods (3.11, 1.5)
8. Sending domain + DNS records (4.3, 4.4)
9. AI provider, BYO-key decision, and enabled features (7.1–7.3)
10. Workday scope and direction — or an explicit decision to defer it (6.1)

---

## Appendix — what HireOps provides, so you don't scope it twice

Already built and configurable, requiring **configuration** from you rather than development:
requisition management with approval routing · candidate pipeline with AI scoring · resume
parsing · duplicate detection · interview scheduling with candidate self-confirm · panel
feedback and scorecards · offer management with compensation bands · onboarding (documents,
BGV, IT provisioning, assets, learning) · offboarding (exit interviews, asset return,
settlement) · partner/agency portal with commercial terms and fee accrual · a 9-report
analytics module with CSV export and scheduled digests · the Iris assistant · full audit
logging, PII access logging, consent capture and retention policy enforcement · 23 admin
configuration surfaces.

**Not built** — requires a scoped work package: SSO/SAML and SCIM · Workday (or any HRMS)
integration · the interview notetaker · diversity/EEO reporting · quality-of-hire and early
attrition analytics · PDF export (board packs are print-styled pages today).
