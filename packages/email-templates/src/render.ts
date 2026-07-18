import { render } from "@react-email/render";
import type { TemplateKey } from "@hireops/notifications";
import {
  ApplicationReceived,
  type ApplicationReceivedProps,
} from "./templates/application-received";
import { StageAdvanced, type StageAdvancedProps } from "./templates/stage-advanced";
import { SlaBreachImminent, type SlaBreachImminentProps } from "./templates/sla-breach-imminent";
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
}

export async function renderTemplate(
  key: TemplateKey,
  data: Record<string, unknown>,
): Promise<RenderedTemplate> {
  switch (key) {
    case "candidate.application_received": {
      const props = data as unknown as ApplicationReceivedProps;
      const element = ApplicationReceived(props);
      return {
        subject: `We received your application for ${props.positionTitle}`,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.stage_advanced": {
      const props = data as unknown as StageAdvancedProps;
      const element = StageAdvanced(props);
      return {
        subject: `Update on your application — ${props.positionTitle}`,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.offer_extended": {
      const props = data as unknown as OfferExtendedProps;
      const element = OfferExtended(props);
      return {
        subject: `Your offer of employment — ${props.positionTitle} at ${props.companyName}`,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.interview_invitation": {
      const props = data as unknown as InterviewInvitationProps;
      const element = InterviewInvitation(props);
      return {
        subject: `Interview invitation — ${props.roundName} for ${props.positionTitle}`,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.interview_cancelled": {
      const props = data as unknown as InterviewCancelledProps;
      const element = InterviewCancelled(props);
      return {
        subject: `Your ${props.roundName} interview for ${props.positionTitle} has been cancelled`,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "candidate.account_activation": {
      const props = data as unknown as CandidateAccountActivationProps;
      const element = CandidateAccountActivation(props);
      return {
        subject: `Activate your ${props.companyName} candidate account`,
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
      const element = AgentMessage(props);
      const approvedSubject =
        typeof props.subject === "string" && props.subject.trim().length > 0
          ? props.subject
          : `Update on your application — ${props.positionTitle}`;
      return {
        subject: approvedSubject,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "recruiter.sla_breach_imminent": {
      const props = data as unknown as SlaBreachImminentProps;
      const element = SlaBreachImminent(props);
      const noun = props.applicationCount === 1 ? "application" : "applications";
      return {
        subject: `Heads up — ${props.applicationCount} ${noun} near SLA breach`,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "recruiter.offer_accepted": {
      const props = data as unknown as OfferAcceptedRecruiterProps;
      const element = OfferAcceptedRecruiter(props);
      return {
        subject: `Offer accepted — ${props.candidateName} for ${props.positionTitle}`,
        html: await render(element),
        text: await render(element, { plainText: true }),
      };
    }
    case "recruiter.offer_declined": {
      const props = data as unknown as OfferDeclinedRecruiterProps;
      const element = OfferDeclinedRecruiter(props);
      return {
        subject: `Offer declined — ${props.candidateName} for ${props.positionTitle}`,
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
