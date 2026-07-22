import { render } from "@react-email/render";
import type { TemplateKey, EmailAttachment } from "@hireops/notifications";
import { buildInterviewIcs } from "./ics";
import { interpolateSlot, type EmailTemplateOverrides } from "./catalog";
import type { SlotOverrides } from "./slots";
import {
  ApplicationReceived,
  type ApplicationReceivedProps,
} from "./templates/application-received";
import { StageAdvanced, type StageAdvancedProps } from "./templates/stage-advanced";
import { SlaBreachImminent, type SlaBreachImminentProps } from "./templates/sla-breach-imminent";
import { SlaOpsAlert, type SlaOpsAlertProps } from "./templates/sla-ops-alert";
import { OfferExtended, type OfferExtendedProps } from "./templates/offer-extended";
import {
  InterviewInvitation,
  type InterviewInvitationProps,
} from "./templates/interview-invitation";
import { InterviewCancelled, type InterviewCancelledProps } from "./templates/interview-cancelled";
import {
  CandidateAccountActivation,
  type CandidateAccountActivationProps,
} from "./templates/candidate-account-activation";
import {
  OfferAcceptedRecruiter,
  type OfferAcceptedRecruiterProps,
} from "./templates/offer-accepted-recruiter";
import {
  OfferDeclinedRecruiter,
  type OfferDeclinedRecruiterProps,
} from "./templates/offer-declined-recruiter";
import { AgentMessage, type AgentMessageProps } from "./templates/agent-message";

/**
 * Template registry — single switch the worker calls to turn a
 * (templateKey, templateData) pair into (subject, html, text). New
 * templates: add the import, the literal in @hireops/notifications'
 * TemplateKey union, and a case here.
 *
 * Subject lines are owned by the registry, not the caller — keeps
 * copy editable in one place.
 *
 * TENANT COPY OVERRIDES (T1.4 / G09): the optional third arg carries a tenant's
 * subject + named-slot overrides (loaded by the dispatcher from
 * tenant_email_template_overrides). When present, the override subject is
 * token-interpolated against the template's data and the slot overrides are
 * passed as the template's `slots` prop; when ABSENT (undefined), every case
 * emits exactly the code-owned defaults — the render is byte-identical to a
 * tenant with no override row. Only the subject + the named text slots in
 * EMAIL_TEMPLATE_CATALOG are overridable; layout, styles, and DATA bindings
 * stay code-owned (there is deliberately no raw-HTML editor).
 *
 * REQUIRED for every new template `.tsx`: start the file with the pragma
 *   /** @jsxRuntime automatic @jsxImportSource react *\/
 * The worker consumes these files' SOURCE through `tsx`, which applies a
 * tsconfig's `jsx` setting only to files inside that tsconfig's `include`
 * scope and falls back to the CLASSIC `React.createElement` transform for
 * everything else — including this cross-package directory. Classic emit
 * needs a `React` global that isn't there, so the render throws
 * "React is not defined" at runtime (dev/demo email send), invisible to
 * typecheck. The per-file pragma forces the automatic runtime regardless
 * of who transforms the file; `react/jsx-runtime` resolves via this
 * package's own `react` dependency. Omit it and the template compiles but
 * fails the moment the worker tries to send it.
 */

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
  /** Optional file attachments (A13 — the interview .ics). The dispatcher
   * forwards these to the EmailProvider. */
  attachments?: EmailAttachment[];
}

/** Resolve the subject line: interpolate the tenant override against the
 * template's tokens when present, else fall back to the code-owned default. */
function resolveSubject(
  override: string | undefined,
  tokens: Record<string, string>,
  fallback: string,
): string {
  return override ? interpolateSlot(override, tokens) : fallback;
}

export async function renderTemplate(
  key: TemplateKey,
  data: Record<string, unknown>,
  overrides?: EmailTemplateOverrides,
): Promise<RenderedTemplate> {
  const slots: SlotOverrides | undefined = overrides?.slots;
  switch (key) {
    case "candidate.application_received": {
      const props = data as unknown as ApplicationReceivedProps;
      const element = ApplicationReceived({ ...props, slots });
      return {
        subject: resolveSubject(
          overrides?.subject,
          { positionTitle: props.positionTitle },
          `We received your application for ${props.positionTitle}`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.stage_advanced": {
      const props = data as unknown as StageAdvancedProps;
      const element = StageAdvanced({ ...props, slots });
      return {
        subject: resolveSubject(
          overrides?.subject,
          { positionTitle: props.positionTitle },
          `Update on your application — ${props.positionTitle}`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.offer_extended": {
      const props = data as unknown as OfferExtendedProps;
      const element = OfferExtended({ ...props, slots });
      return {
        subject: resolveSubject(
          overrides?.subject,
          { positionTitle: props.positionTitle, companyName: props.companyName },
          `Your offer of employment — ${props.positionTitle} at ${props.companyName}`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.interview_invitation": {
      const props = data as unknown as InterviewInvitationProps;
      const element = InterviewInvitation({ ...props, slots });
      // A13 honest slice — attach a REAL generated .ics when we have a concrete
      // start instant. A TBC interview gets no calendar file (we don't invent a
      // time). No third-party API, no fake sync.
      const ics =
        props.interviewStartIso && props.interviewId
          ? buildInterviewIcs({
              interviewId: props.interviewId,
              candidateName: props.candidateName,
              companyName: props.companyName,
              positionTitle: props.positionTitle,
              roundName: props.roundName,
              interviewStartIso: props.interviewStartIso,
              durationMinutes: props.durationMinutes,
              modeLabel: props.modeLabel,
              meetingUrl: props.meetingUrl,
              confirmUrl: props.confirmUrl,
            })
          : null;
      return {
        subject: resolveSubject(
          overrides?.subject,
          { roundName: props.roundName, positionTitle: props.positionTitle },
          `Interview invitation — ${props.roundName} for ${props.positionTitle}`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
        ...(ics ? { attachments: [ics] } : {}),
      };
    }
    case "candidate.interview_cancelled": {
      const props = data as unknown as InterviewCancelledProps;
      const element = InterviewCancelled({ ...props, slots });
      return {
        subject: resolveSubject(
          overrides?.subject,
          { roundName: props.roundName, positionTitle: props.positionTitle },
          `Your ${props.roundName} interview for ${props.positionTitle} has been cancelled`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.account_activation": {
      const props = data as unknown as CandidateAccountActivationProps;
      const element = CandidateAccountActivation({ ...props, slots });
      return {
        subject: resolveSubject(
          overrides?.subject,
          { companyName: props.companyName },
          `Activate your ${props.companyName} candidate account`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.agent_message": {
      // The only template whose subject is caller-owned: the body is an
      // agent draft that a recruiter approved, and the subject was
      // approved alongside it. Fall back to the registry-style subject
      // if templateData somehow lacks one, so a missing field degrades
      // to a sane email rather than an empty subject line.
      const props = data as unknown as AgentMessageProps & { subject?: unknown };
      const element = AgentMessage({ ...props, slots });
      // The approved subject wins. When the draft carries none, the tenant's
      // subject override (if any) is the fallback, else the registry default.
      const approvedSubject =
        typeof props.subject === "string" && props.subject.trim().length > 0
          ? props.subject
          : resolveSubject(
              overrides?.subject,
              { positionTitle: props.positionTitle },
              `Update on your application — ${props.positionTitle}`,
            );
      return {
        subject: approvedSubject,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "recruiter.sla_breach_imminent": {
      const props = data as unknown as SlaBreachImminentProps;
      const element = SlaBreachImminent({ ...props, slots });
      const noun = props.applicationCount === 1 ? "application" : "applications";
      return {
        subject: resolveSubject(
          overrides?.subject,
          { applicationCount: String(props.applicationCount), noun },
          `Heads up — ${props.applicationCount} ${noun} near SLA breach`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "recruiter.sla_ops_alert": {
      // Operational alert to an admin-configured recipient (Email Alerts
      // recipient or Escalation Rule recipient). Subject is the worker-
      // composed headline, prefixed with severity when the escalation
      // rule carried one.
      const props = data as unknown as SlaOpsAlertProps;
      const element = SlaOpsAlert(props);
      const subject = props.severity
        ? `[${props.severity.toUpperCase()}] ${props.headline}`
        : props.headline;
      return {
        subject,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "recruiter.offer_accepted": {
      const props = data as unknown as OfferAcceptedRecruiterProps;
      const element = OfferAcceptedRecruiter({ ...props, slots });
      return {
        subject: resolveSubject(
          overrides?.subject,
          { candidateName: props.candidateName, positionTitle: props.positionTitle },
          `Offer accepted — ${props.candidateName} for ${props.positionTitle}`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "recruiter.offer_declined": {
      const props = data as unknown as OfferDeclinedRecruiterProps;
      const element = OfferDeclinedRecruiter({ ...props, slots });
      return {
        subject: resolveSubject(
          overrides?.subject,
          { candidateName: props.candidateName, positionTitle: props.positionTitle },
          `Offer declined — ${props.candidateName} for ${props.positionTitle}`,
        ),
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    default: {
      // Exhaustiveness guard — adding a TemplateKey without a case fails here.
      const _exhaustive: never = key;
      void _exhaustive;
      throw new Error(`No template registered for key=${key as string}`);
    }
  }
}
