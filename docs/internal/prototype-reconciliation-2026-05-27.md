# HireOps — Prototype-vs-Build Reconciliation (2026-05-27)

**Audit method:** Walked the procurve-ai-main codebase at `~/desktop/workspace/procurve-ai-main` (the source for `procurve-ai.lovable.app`). Read all 78 pages across 7 personas plus root pages. Extracted 60 distinct feature claims. Mapped each to current build state using the same status taxonomy as AUDIT-01 (`completion-audit-2026-05-26.md`), with the addition of NOT IN BUILD SCOPE for claims the build plan never intended to deliver. Read-and-report only — no code, schema, or test was touched.

**Companion to:** `docs/internal/completion-audit-2026-05-26.md` (yesterday's build-state audit; 137 features documented, 21.2% production-complete, 25.5% demo-functional).

---

## Section 1 — Headline numbers

| Status | Count | % of 60 |
|---|---|---|
| **SHIPPED** | 2 | 3.3% |
| **SHIPPED-SIMULATED** | 0 | 0% |
| **PARTIAL** | 13 | 21.7% |
| **NOT STARTED** | 19 | 31.7% |
| **DEFERRED** | 5 | 8.3% |
| **NOT IN BUILD SCOPE** | 21 | 35.0% |
| **Prototype-to-build alignment % (SHIPPED + SHIPPED-SIMULATED)** | | **3.3%** |

Inverse drift — built features not shown in prototype: **roughly 18 of the 35 SHIPPED/SHIPPED-SIMULATED items from AUDIT-01** are absent from the prototype narrative. The infrastructure tier (tenancy, RLS, KMS envelope encryption, integration credentials, observability, CI/CD) is necessarily invisible. The consumer-visible inverse drift items — features built and pitchable but missing from the prototype — are:

- Public apply form at `/t/{tenant}/apply/{req-slug}` (D3/D5/D6) — the recruitment funnel's entry point
- Candidate-side offer accept via signed-link `/offer/[token]` (M4)
- Workday simulation drain + Integration Health screen (I8 / F4) — the demo's "look, Workday-integration-shaped object" surface
- Knockout evaluator with typed dispatch + null-vs-false semantics (O2)
- Reverse-mutation undo UX pattern (E4) — the prototype uses drag-and-drop kanban instead
- Candidate ownership state machine with partial-unique partner index (H1) — the partner concept does not exist anywhere in the prototype
- AI score discriminator with prompt_version audit (O3) — partially surfaced as "AI Shortlist with explanations" but the *scored_by* discriminator (anthropic/openai/local/simulated/skipped) is invisible
- Per-tenant AI provider routing via `tenants.settings.ai_provider` (C1) — the prototype shows model-config but not tenant-scoped routing
- Tenant onboarding workflow MVP (A6) — invisible to demo viewers

The structural infrastructure layer (compound FKs, RLS lint, JWT `tid` propagation, AsyncLocalStorage, outbox dispatcher, scheduled-job-runs framework) is correctly invisible to the prototype — that's plumbing — but represents the bulk of the AUDIT-01 SHIPPED count.

---

## Section 2 — Feature claim table

Sorted by gap category (Wedge-critical first), then by prototype claim within category.

### Wedge-critical (gap threatens the HR-configurable-agents pitch)

| # | Prototype claim | Prototype location | Framing language (verbatim) | Build status | Evidence | Notes |
|---|---|---|---|---|---|---|
| 12 | Workflow/automation engine with 12 named workflows | `/app/admin/workflows` | "Control automation pipelines, toggle and monitor run history" | PARTIAL | `apps/workers/src/{index,lib/dispatcher,lib/scheduler,lib/ai-score-drain,lib/workday-simulation-drain}.ts`; `scheduled_job_runs` table | Underlying worker loops exist for 4 of 12 prototype workflows (CV Parser, Candidate Notification, Scorecard Aggregator-equivalent, Smart Sourcing-stub). No HR-visible admin UI; no toggle; no run-history view. The wedge claim "HR configures automation" has neither prototype nor build support. |
| 13 | "Create Workflow" button (HR-initiated) | `/app/admin/workflows` | "Create Workflow" dialog (name + description) | NOT IN BUILD SCOPE | No admin workflow CRUD in `apps/internal-portal` or any router procedure | Even the prototype's create dialog is stub (name + description only — no trigger config, no action config). Build never planned this. |
| 14 | AI Report Scheduler — "AI-driven scheduler triggers agents to generate reports" | `/app/admin/dashboard` | Explicit "Coming Soon" tile | NOT IN BUILD SCOPE | No reference in any `.md` doc; not in `wave-1-backlog.md` | The single explicit "agents" mention in the prototype is itself a "Coming Soon" placeholder. |
| 23 | Multi-level approval chains + inbox + SLA tracker + history | `/app/owner/approvals`, `/app/hr-head/approvals` | "Pending Approval SLA" + "Approval History" | NOT STARTED | `approval_chains`, `approval_requests`, `approval_decisions`, `approval_matrices` schema shipped (migrations 0014/0017); zero tRPC procedures; zero UI in `apps/internal-portal` | Largest documented schema/UI gap. AUDIT-01 §6 flagged this as "looks shipped because schema is shipped, but isn't usable". |
| 12.b | Approval rules HR can configure (autonomous vs human-in-loop) | (implied across workflows + approvals) | n/a | NOT STARTED | No router procedures; no admin matrix configuration UI | Critical for the wedge: HR has no surface to say "agent X runs autonomously, agent Y requires human approval." |

### Demo-visible (gap would surface in a live demo / code walkthrough)

| # | Prototype claim | Prototype location | Framing language | Build status | Evidence | Notes |
|---|---|---|---|---|---|---|
| 2 | Six-portal architecture + role-based access | Landing modal | "Six dedicated portals, one unified platform" | PARTIAL | Only `apps/internal-portal` is real. `apps/candidate-portal/src/index.ts`, `apps/partner-portal/src/index.ts`, `apps/careers-site/src/index.ts` are `export {};` stubs | A demo viewer clicking "Candidate" or "Partner" lands nowhere. Apply form is embedded inside internal-portal via middleware allowlist. |
| 4 | AI JD generation (multi-section + per-section regenerate + version history) | `/app/owner/jd-builder` | "AI JD generation with org/dept/role context" | NOT STARTED | `jd_versions` + `jd_skills` schema shipped; no router procedure; no UI; no edge-function-equivalent | Prototype has a live Supabase Edge Function `jd-assistant`. Build has the AI client + schema but never wired the JD-generation path. |
| 6 | Per-skill weighting + score preview | `/app/owner/skill-weights` | "Skill Weighting"; live score preview | PARTIAL | `jd_skills.weight` column exists; no UI; no score-preview path | Build has the data column; nothing reads or writes it through a recruiter-facing surface. |
| 7 | AI scoring with criterion-by-criterion explanation | `/app/recruiter/ai-shortlist` | "AI Shortlist" with explanations | SHIPPED | `apps/workers/src/lib/ai-score-drain.ts`; `ai_score_explanation` JSONB with `top_factors` array per HANDOVER #92; surfaced in `AIScoreBadge` triage component | One of two claims that lands cleanly. |
| 8 | Bias detection rules CRUD + threshold sliders + D&I dashboard | `/app/admin/thresholds` | "Manage D&I compliance rules and bias detection thresholds" | NOT STARTED | `bias_rules` table NOT in `packages/db/src/schema/`; no migration; no UI | Schema gap before UI gap. The prototype's bias-rule CRUD has no data model to point at in the build. |
| 9 | AI model + temperature + max-tokens configuration UI | `/app/admin/ai-settings` | "Configure AI model parameters" | PARTIAL | `tenants.settings.ai_provider` (free-text key) routes per-tenant; no temperature/max-tokens UI; no admin route | Build routing is provider-only; prototype shows model + temp + max-tokens sliders. |
| 10 | AI feature usage table (calls / tokens / cost USD / avg latency per feature) | `/app/admin/ai-settings` | "AI Feature Usage" table | PARTIAL | `ai_usage_logs` table has all the data (provider/model/feature/input_tokens/output_tokens/cost_micros/latency_ms); no admin UI to query it | Closest-to-shippable PARTIAL on the list — query layer is the missing piece. |
| 11 | PII masking + auto-redact + audit-AI-decisions + fairness threshold toggles | `/app/admin/ai-settings` | "Bias & Compliance" toggles | PARTIAL | Audit-AI-decisions partly covered by `api_audit_logs` + `ai_usage_logs`; PII masking + redaction not in code; fairness threshold not in code | Wedge-adjacent — the trust/governance surface is largely missing. |
| 15 | Integrations health dashboard (8 named integrations) | `/app/admin/integrations` | "Integrations" with health %, status, last-checked | PARTIAL | `/admin/integrations` exists in `apps/internal-portal/src/app/admin/integrations/` but renders Workday-only (reads `workday_sync_outbox`); the other 7 prototype integrations (Supabase/SendGrid/WhatsApp/Calendar/Storage/Voice Agent/ATS/Webhooks) have no admin tiles | Prototype integration list does not overlap with build's actual integrations (Workday simulator). |
| 21 | Multi-channel notifications + Messaging Center | `/app/admin/messaging` | "Manage WhatsApp providers, messages, and templates" | PARTIAL | `notification_outbox` + `dev_email_outbox` shipped; 6 react-email templates hard-coded in `packages/email-templates`; no admin UI to manage templates; no WhatsApp wiring | Templates exist in code, not in a managed library. |
| 22 | Email Alert Configuration + Delay Escalation Rules | `/app/admin/system-setup` | "Delay Escalation Rule" | NOT STARTED | `sla_imminent_scan` job covers part of "delay escalation" but is hard-coded thresholds (per HANDOVER #54) | The SLA scanner exists; the HR-configurable escalation surface does not. |
| 24 | Multi-step requisition creation wizard with budget alignment | `/app/owner/requisitions/new` | "Create Requisition" wizard | NOT STARTED | `requisitions` schema shipped; no creation UI; no router procedure | Demoable today only via direct seed-data SQL. |
| 25 | Requisition state machine with drag-and-drop pipeline view | `/app/pipeline` | "Drag candidates between stages to update their status" | NOT IN BUILD SCOPE | Build uses Hot Zone + Momentum Feed (`apps/internal-portal/src/components/triage/`) not drag-drop kanban; state machine itself IS shipped on the data side (advanceApplication / rejectApplication / revertApplicationStage) | Different UX choice. The state machine ships; the interaction model doesn't. |
| 26 | AI candidate brief (panel pre-interview) | `/app/panel/candidate/:id` | "Candidate Brief" | NOT STARTED | No panel route; no AI brief endpoint | Wave 1 backlog INT-17 planned this. Not built. |
| 27 | Structured panel scorecard (config-driven) | `/app/panel/scorecard/:interviewId` | "Advanced Scorecard" | NOT STARTED | No interview schema (no `interviews` / `interview_feedback` / `interview_summaries` / `interview_plans` tables despite architecture §5.1 listing them) | Schema gap upstream of UI gap. |
| 28 | Panel feedback SLA inbox + history | `/app/panel/feedback`, `/app/panel/history` | "Feedback Submissions" / "Past Interviews" | NOT STARTED | No panel UI; no interview schema | Same schema gap. |
| 29 | Live Interview Monitor (real-time sessions with packet loss, recording status, AI signals, Escalate-to-HR-Head) | `/app/panel/monitor` | "Live Interview Monitor" | NOT IN BUILD SCOPE | No live-monitoring code; not in any `.md` doc | Most visually distinctive prototype feature; entirely absent from build plans. |
| 30 | In-app video interview rooms (Recruiter / Panel / Candidate variants) | multiple routes | "Interview Room" | NOT IN BUILD SCOPE | architecture §8.3 explicitly says "No custom WebRTC build" — integrate Zoom/Teams instead | Build is correct to defer; prototype shows WebRTC shells that were never going to be built. |
| 31 | Calendar-integrated interview scheduling (Google Calendar) | `/app/recruiter/scheduling` | "Schedule and manage interview sessions" | NOT STARTED | No calendar OAuth; no interview scheduling code | Wave 1 backlog API-11 planned this. Not built. |
| 32 | AI transcript analytics + interview highlights | (claimed across Landing + Panel Monitor) | "Transcript analytics & highlights" | DEFERRED | `requirements.md` §5.5 Wave 2 | — |
| 33 | Real-time captions + translation for interviews | Landing | "Real-time captions and translation for global hiring" | NOT IN BUILD SCOPE | Not in any `.md` doc | Aspirational; never planned. |
| 34 | Comp & Offer Recommendations + offer drafting | `/app/hr-team/offers` | "Comp & Offer Recommendations" | PARTIAL | Offer drafting + accept-via-signed-link SHIPPED (Module 4); comp recommendation engine NOT STARTED | The accept side is shipped, the recommend side isn't. |
| 35 | HR Cases — manage candidates post-tech-round through HR Round / Offer / Docs | `/app/hr-team/cases` | "Manage candidates post technical rounds" | NOT STARTED | No `cases` polymorphic table; no UI | Wave 1 backlog INT-12 planned this. |
| 37 | Documents & Verification (HR Ops + Candidate sides) | `/app/hr-team/documents`, `/candidate/documents` | "Documents & Verification" | NOT STARTED | No `document_types` reference table (despite architecture §5.1 listing it); no `onboarding_documents` table | Schema gap + UI gap. |
| 38 | Candidate document upload + status | `/candidate/documents` | "Documents" | NOT STARTED | No candidate-portal app | — |
| 44 | Pipeline by Stage (HR Head cross-recruiter view) | `/app/hr-head/pipeline` | "Pipeline by Stage" | NOT STARTED | No HR Head route in `apps/internal-portal` | — |
| 47 | Recruiter Candidates list + Detail (multi-tab) | `/app/recruiter/candidates`, `/app/recruiter/candidates/:id` | List + multi-tab detail | PARTIAL | List shipped (`listCandidates` with faceted filters); detail is a drawer (`CandidateDetailDrawer.tsx`), not the multi-tab page in `requirements.md` §10.1 + design-system §7.5 | UX is reduced — drawer not tabbed full page. |
| 48 | AI Shortlist (recruiter, score-ordered) | `/app/recruiter/ai-shortlist`, `/app/recruiter/shortlist` | "AI Shortlist" | SHIPPED | Momentum Feed in `apps/internal-portal/src/components/triage/MomentumFeed.tsx` is the score-ordered surface | The other claim that lands cleanly. |
| 53 | Audit & Compliance UI (Admin / HR Head / HR Team variants) | three audit routes | "Audit & Compliance" | PARTIAL | `audit_logs` + `api_audit_logs` schema shipped + populated; no admin UI to query | Like #10 — query layer is the missing piece. |
| 55 | Theme & Branding white-labelling | `/app/admin/branding` | "Theme & Branding" + Live Preview | NOT STARTED | `tenants.settings` JSONB has the slot per ADR-002; design-system §8 specifies brand-only overrides; no admin UI; no per-tenant rendering | — |
| 57 | Users & Roles management UI | `/app/admin/users` | "Users & Roles" | NOT STARTED | `tenant_user_memberships` + 11-role `tenant_role` enum shipped; provisioning is by seed script only | — |
| 58 | Global Settings UI | `/app/admin/settings` | "Global Settings" | NOT STARTED | No admin route | — |
| 59 | Dashboard widgets + KPI tiles per persona | every persona dashboard | various | PARTIAL | Recruiter triage exists as the only persona dashboard; HM / Panel / HR Ops / HR Head / Admin / Candidate dashboards absent | Six of seven persona dashboards missing. |

### Onboarding-promise (reasonable to defer to post-demo onboarding window without breaking wedge)

| # | Prototype claim | Status | Notes |
|---|---|---|---|
| 5 | JD library | NOT STARTED | Schema only; UI deferrable |
| 19 | WhatsApp Business + templates + follow-up + enrichment | DEFERRED | Wave 2 per `requirements.md` §11 |
| 20 | Multi-channel sourcing (LinkedIn/Indeed/Naukri) | DEFERRED | Wave 2 |
| 36 | HR Round Scheduler | NOT STARTED | — |
| 39 | Templates & Policies library | NOT STARTED | — |
| 43 | Executive Analytics + Cost-per-Hire | DEFERRED | Wave 2 |
| 45 | Recruiter Analytics + HR Analytics | DEFERRED | Wave 2 |
| 46 | Recruiter Missing Info (data hygiene) | NOT STARTED | — |
| 54 | Policy & Governance library | NOT STARTED | — |
| 56 | Multilingual + RTL/LTR | NOT IN BUILD SCOPE | English-only POC per requirements §9.9; not Hindi/Tamil/Telugu — explicit defer |

### Post-POC roadmap (long-term direction-of-travel, fine to defer past onboarding)

| # | Prototype claim | Status | Notes |
|---|---|---|---|
| 1 | AI-mediated recruitment ecosystem positioning | PARTIAL | AI infra shipped; consumer surfaces sparse |
| 16 | AI Voice Agent for phone screening | NOT IN BUILD SCOPE | Listed "Disconnected" in prototype; aspirational |
| 18 | Outbound webhooks (3 endpoints) | NOT IN BUILD SCOPE | Not in build plans |
| 32 | Interview AI transcript + highlights | DEFERRED | Wave 2 |
| 60 | "24/7 Candidate Assistant" positioning | NOT IN BUILD SCOPE | Explicit POC drop per requirements §10.6 / §11 |

### Drop the claim (not important enough to either build or pitch — remove from prototype going forward)

| # | Prototype claim | Status | Rationale for dropping |
|---|---|---|---|
| 17 | External ATS bi-directional sync (Greenhouse) | NOT IN BUILD SCOPE | The build IS the ATS. The prototype's "we sync with Greenhouse" tile contradicts the multi-tenant SaaS-ATS positioning. Surface as drift to remove. |
| 40 | Owner/HR Head predictive Insights (Health Score / Hiring Difficulty / Offer Acceptance Probability) | NOT IN BUILD SCOPE | Explicit POC drop per requirements §10.2 / §10.3 (predictive items dropped) |
| 41 | Feasibility Reports | NOT IN BUILD SCOPE | Same explicit POC drop per requirements §10.3 |
| 42 | Market Intelligence | NOT IN BUILD SCOPE | Same explicit POC drop per requirements §10.3 |
| 49 | Candidate AI Coach (24/7 chat, mock interview, STAR) | NOT IN BUILD SCOPE | Explicit POC drop per requirements §10.6 / §11 (523-line page, expensive in tokens, not POC-critical) |
| 50 | Candidate Applications tracker | NOT IN BUILD SCOPE | No candidate-portal app planned for Wave 1; the apply form lives in internal-portal |
| 51 | Candidate Notifications feed | NOT IN BUILD SCOPE | Same |
| 52 | Candidate Settings | NOT IN BUILD SCOPE | Same |
| 3 | Candidate OTP signup | NOT IN BUILD SCOPE | Build candidate auth uses Supabase email/password + magic link, not phone OTP |

### N/A (claims that match shipped build)

| # | Claim | Status |
|---|---|---|
| 7 | AI scoring with criterion-by-criterion explanation | SHIPPED |
| 48 | AI Shortlist (recruiter, score-ordered) | SHIPPED |

---

## Section 3 — HR-configurable agent frame check

The wedge is: *HR teams configure their own agents to perform hiring + onboarding + offboarding workflows, without engineering involvement. HR directs, the platform does the work.*

| # | Question | Prototype shows it? | Build delivers it? | Gap size + recommendation |
|---|---|---|---|---|
| 1 | **Agent definitions HR can create / edit** | **PARTIAL** — "Create Workflow" dialog on `/app/admin/workflows` accepts name + description only. No agent body, no model selection per agent, no input/output schema. | **NO** — no admin workflow CRUD route in `apps/internal-portal`; no router procedure for workflow definition; no `workflows` / `workflow_runs` tables despite architecture §5.1 listing them | Large gap. The prototype gestures at the surface but the form is two text inputs. Build hasn't started this. **Recommendation: this is the wedge — if it's not buildable in 2-3 weeks for the demo, the pitch needs to soften from "HR configures agents" to "HR configures policy and the platform runs configured workflows."** |
| 2 | **Trigger configuration (event-based or scheduled) HR can set** | **NO** — workflow rows show trigger type (Event / Cron / Manual) as a display badge; cannot be edited from the UI. | **NO** — `scheduled_job_runs` table is platform-allowlisted (per HANDOVER #67) with intervalMs hard-coded in `apps/workers/src/index.ts`. No admin trigger surface. | Large gap. **Recommendation: most demonstrable agent feature; build a trigger picker (event vs cron schedule) before the demo if the wedge needs to land.** |
| 3 | **Action configuration (what the agent does) HR can set** | **NO** — no action editor in the prototype | **NO** — actions are hard-coded in worker code (`drainOutboxOnce`, `slaImminentScan`, `drainWorkdayOutboxOnce`, `drainAiScoreOutboxOnce`) | Large gap. Honestly very hard to build credibly in a short window — actions are code, not config. **Recommendation: lean into "curated agent library" framing rather than "build-your-own-agent" framing.** |
| 4 | **Approval rules (autonomous vs human-in-loop) HR can configure** | **NO** — Owner Approval Tracker exists for requisition approvals, but not for agent decision-gating. The bias compliance toggles ("audit AI decisions") are the closest. | **NO** — `approval_chains` + `approval_matrices` schema exists (migrations 0014/0017); zero tRPC procedures; no UI. AUDIT-01 flagged this as the "looks shipped but isn't usable" gap. | Large gap. **Recommendation: of all seven questions, this is the cheapest to ship credibly because the schema is already there. A list-pending-approvals + approve/reject-with-comment UI is one ticket.** |
| 5 | **Audit view of what agents did and why** | **PARTIAL** — Admin Workflows page shows per-workflow run history with status (success/failed/running), latency, retry button. No "why" surface beyond error string. | **PARTIAL** — `audit_logs` + `api_audit_logs` + `ai_usage_logs` + state-transition tables all populated; `ai_score_explanation.scored_by` + `top_factors` + `prompt_version` per HANDOVER #92, #97; **no admin UI to query any of this** | Medium gap. Build has more data than the prototype, just no surface. **Recommendation: ship an admin audit list view in the demo window. Schema is there. This is shippable.** |
| 6 | **Cost/usage view per agent** | **PARTIAL** — Admin AI Settings has "AI Feature Usage" table (calls / tokens / cost USD / avg latency per *feature*, not per workflow) | **PARTIAL** — `ai_usage_logs` has `cost_micros` + `provider` + `model` + `feature` + token counts + latency; no admin UI | Small gap. **Recommendation: same as #5 — ship a basic cost dashboard. Data is there in integer paise/micros.** |
| 7 | **Agent templates or recipe library** | **NO** — no template gallery; the 12 workflows are seeded into the prototype but not framed as "templates you can clone" | **NO** — no workflow_templates table; nothing in code | Large gap. **Recommendation: lowest priority of the seven — the recipe library is the *output* of having a real agent engine, not its precondition. Defer.** |

**Wedge summary:** of the seven, the build has the data foundation for **#5 (audit), #6 (cost/usage), and #4 (approvals — schema only)**. None of the three has an admin UI. The remaining four (#1 agent definitions, #2 triggers, #3 actions, #7 templates) are not started in code and only gestured at in the prototype.

The wedge story "HR directs and the platform does the work" is currently aspirational in both prototype and build. **The smallest credible demo: build #4 (approval inbox) + #5 (audit list view) + #6 (cost-per-feature dashboard) and call them "configurable hiring policy + visibility into automated decisions". That's three tickets — roughly 2-3 weeks of solo orchestration — and it lets you talk about the wedge with a working surface to point at.**

---

## Section 4 — Inverse drift (built but not shown in prototype)

Of the 35 SHIPPED + SHIPPED-SIMULATED features from AUDIT-01, the breakdown of what's NOT visible in the prototype:

### Infrastructure tier — correctly invisible

These are plumbing. Should NOT be surfaced in the prototype; their value is enabling, not pitching. Keep as infrastructure-only.

- A2 Envelope encryption (LocalKmsClient + AwsKmsClient stub)
- A3 Integration credentials store (envelope-encrypted)
- A4 RLS baseline + lint enforcement
- A5 Tenant context middleware (JWT `tid` + AsyncLocalStorage)
- A10 CORS middleware (the prototype claim is "Cloudflare WAF" — different layer)
- B2 Compound (tenant_id, id) FK protection
- B3 Audit logging schema
- C1 AI client abstraction (`packages/ai-client`)
- C5 AI usage logging at row level
- J5 Outbox-first dispatcher + signed-link primitive
- T1 Design tokens (consumer-invisible)
- T3 Foundational UI primitives
- U1 CI/CD GitHub Actions
- U2 Sentry (pluggable local fallback)

### Consumer-visible — investment without prototype narrative

These are built and demonstrable but the prototype doesn't frame them. Each is a candidate for prototype rewrite OR build narrative rewrite.

| Built feature | Why prototype-invisible | Recommendation |
|---|---|---|
| **Public apply form at `/t/{tenant}/apply/{req-slug}`** (D3/D5/D6) | The prototype has Candidate signup via OTP and a separate Pipeline page; no public job-listing → apply flow. The build's apply form is the funnel's entry point and a working demo flow. | **Surface in prototype rewrite.** Or at minimum, in any pitch deck, this is "the candidate-side wedge demo" — show the QR-coded apply link and the immediate AI-scored result on the recruiter side. |
| **Candidate-side offer accept via signed link `/offer/[token]`** (M4) | Prototype has `HRTeamOffers` for offer management but no candidate-side accept. The build's signed-link accept page is mobile-first and demoable. | **Surface in prototype rewrite.** The accept-on-phone moment is highly demoable. |
| **Workday simulation drain + `/admin/integrations` view** (I8 / F4) | The prototype has no Workday concept at all (its "ATS" integration is Greenhouse). The build's simulator is honest about being a simulator (renders `simulation_notes: "This is a simulated response..."`). | **Keep simulator as infrastructure-only for now.** The prototype's lack of Workday framing is a defensible content choice — surface Workday integration only when real SOAP client lands. Drop the prototype's "Greenhouse ATS Sync" tile in any rewrite. |
| **Knockout evaluator** (O2) — sync deterministic dispatch on parsed CV fields | Prototype shows knockouts on the partner submit form (but no partner portal in prototype) and on the recruiter shortlist. Build runs them at apply time. | **Surface in prototype rewrite — but only after the apply form is added.** Knockouts before AI scoring is a clean wedge moment: "we don't even pay LLM tokens on candidates who fail dealbreakers." |
| **Candidate ownership claim state machine + partial-unique index** (H1) | Partner concept does not exist anywhere in the prototype. No partner portal stub even on Landing. | **Keep build-only for now; do not pretend it's in the prototype.** The partner portal is the biggest investment-without-narrative item — schema for 9 partner tables shipped, zero UI, zero prototype claim. Decide separately whether the partner channel is in the demo at all. |
| **Reverse-mutation undo (30s server window)** (E4) | Prototype uses drag-drop kanban; build uses advance/reject + undo toast. Different UX choice. | **Keep build pattern; drop drag-drop framing from prototype going forward.** Undo-after-commit is the more honest pattern for audit semantics. |
| **AI score explanation discriminator** (O3) — scored_by anthropic/openai/local/simulated/skipped | Prototype's AI Shortlist shows "AI explanation" but not the *scored_by* meta. | **Surface in prototype rewrite.** The honesty marker ("scored by simulated fixture" vs "scored by anthropic") is a trust-building signal that aligns with the wedge's "AI is configurable and auditable" claim. |
| **SLA-imminent recruiter alert with per-persona digest matrix** (J6) | Prototype's "Delay Escalation Rule" is in System Setup; the build version runs every 15 min as a worker job. | **Surface in prototype as a "what an agent looks like today" example.** This is the closest thing the build has to a working autonomous agent — fires on schedule, sends an email, logs to audit. |
| **AI candidate scoring on submit (real Anthropic provider, smoke confirmed)** (O1) | Prototype's AI Shortlist surfaces the score but the prototype data is fixture-driven. | **Surface differently** — emphasise "real provider, real cost-tracking, sub-10s P95" instead of "AI shortlist exists." |

---

## Section 5 — Honest commentary

The drift between prototype and build is large enough to require honest framing in any demo, but the direction of the drift is not what a casual reader might expect. The prototype promises a recruitment-only product ("From Requisition to Offer") and the build adds onboarding, offboarding, Workday integration, and a partner portal to that scope. So roughly half the build investment is in features that **the prototype never claimed** — which is a different kind of drift from the usual "prototype promises X, build delivers less". Here, both sides over-promise different things: the prototype over-promises persona breadth (six dedicated portals, panel feedback, candidate AI coach, predictive insights), and the build over-promises product breadth (onboarding cases, BGV vendor integration, partner ownership state machine, full e-signature, multi-region tenancy). In neither case is the over-promise yet delivered. The prototype-to-build alignment percentage of 3.3% understates the actual situation because most of the 35% NOT-IN-BUILD-SCOPE items were *correctly* deprioritised (predictive insights, candidate AI coach, real-time interview captions) — they were prototype-only flourishes that the build docs rightly dropped. The 31.7% NOT STARTED items are the real overlap gap: prototype features that the build *intends* to deliver but hasn't yet.

The wedge story — *HR teams configure their own agents to perform hiring workflows, HR directs and the platform does the work* — is gestured at by both prototype and build but delivered by neither. The Admin Workflows page in the prototype shows 12 named workflows with toggle/run/view-runs, which looks superficially like an agent surface. Under the hood, the "Create Workflow" dialog accepts only a name and a description; trigger configuration, action configuration, and approval rules are not editable from the UI. The build has more substance underneath — `notification_outbox` drain, `sla_imminent_scan` on a 15-minute schedule, `ai_score_outbox` drain, `workday_sync_outbox` simulator — but it has *zero* admin UI to surface any of this as agent-shaped. The smallest demo that credibly supports the wedge story is the three-item triad called out in §3: **approval inbox (cheapest because schema exists), audit list view (data exists, just no UI), cost-per-feature dashboard (data exists, just no UI).** None of those three is "agents HR configure" but together they let you say *"the platform runs configured policies on the customer's behalf, with full visibility into what was decided, why, and at what cost."* That's a defensible softer version of the wedge — and it's roughly three tickets. The more ambitious version, where HR genuinely defines new agents with custom triggers and actions, is months of work and looks less like a POC and more like a v1.0 product.

Of the 21 NOT-IN-BUILD-SCOPE prototype claims, **three are load-bearing for the wedge and need to be addressed**, not just deferred. The first is the **AI Voice Agent for phone screening** (listed as "Disconnected" in the prototype's Integrations panel). This is the most distinctive agent-shaped claim — an agent that conducts phone screens autonomously, on the platform's behalf — and it's not in any build doc. If the wedge is "HR configures agents," voice-screening agents are the most credible example to point at. Recommendation: either commit to a 4-week voice-agent spike against Vapi or Bland (off-the-shelf voice-AI), or drop the Voice Agent tile from the prototype going forward. The second is the **External ATS bi-directional sync (Greenhouse)** integration tile. This contradicts the multi-tenant SaaS-ATS positioning of the build docs and confuses the buyer story. Recommendation: drop this from the prototype regardless. The third is the **24/7 Candidate Assistant** positioning. Even though Candidate AI Coach is explicitly POC-dropped in `requirements.md` §10.6, the *positioning* on the Landing hero ("24/7 Candidate Assistant" as one of four hero stats) is a load-bearing claim — candidates asking questions of an LLM 24/7 is a small but believable agent example, especially because the prototype's `candidate-chat` Supabase Edge Function is already a working LLM endpoint. Recommendation: either keep the candidate chat in scope (it's cheap because the prototype already has a live edge function) or drop the "24/7 assistant" stat from the hero.

The biggest unexpected finding from this audit is that **the prototype shows a different product shape than the build is delivering, and the prototype's shape is actually more wedge-credible than the build's shape**. The prototype is recruitment-focused with explicit agent and automation framing on Admin Workflows. The build is full-lifecycle with no admin agent UI at all. If a Kyndryl reviewer cross-references the prototype against a code walkthrough, the dissonance won't be "the build is behind the prototype" — it will be "the build is doing different work." The build's onboarding/offboarding/Workday/partner investment is defensible against the documented requirements but invisible in the prototype, and the prototype's HR-configurable-agent narrative is invisible in the build. **The strongest recommendation: rewrite the prototype to match what the build is actually doing**, or pick the wedge-critical three items from §3 and ship admin UI for them in the next two weeks. Continuing to demo the existing prototype while pointing at the existing build risks the buyer realising the two are describing different products.

One additional flag: the prototype lists **AI Voice Agent for phone screening as "Disconnected"** rather than absent, and **AI Report Scheduler as "Coming Soon" with a roadmap badge**. This is a more honest pattern than the rest of the prototype (which shows 12 workflows running with success rates as if they're real). Recommendation: extend this honesty marker pattern. Any prototype claim that isn't in the build today should be visually labelled "Coming Soon," "Disconnected," or "Pilot" — same way Module 4's Workday simulator carries the literal string *"This is a simulated response. In production, this would be the actual Workday SOAP response."* The buyer who looks closely should be able to tell what's working and what's aspirational from the UI itself.

---

**Audit complete.** No code, schema, migration, test, or non-audit doc was modified during this exercise. Output is this single file: `docs/internal/prototype-reconciliation-2026-05-27.md`.
