import { render } from "@react-email/render";
import type { TemplateKey } from "@hireops/notifications";
import {
  ApplicationReceived,
  type ApplicationReceivedProps,
} from "./templates/application-received";
import { StageAdvanced, type StageAdvancedProps } from "./templates/stage-advanced";
import {
  SlaBreachImminent,
  type SlaBreachImminentProps,
} from "./templates/sla-breach-imminent";

/**
 * Template registry — single switch the worker calls to turn a
 * (templateKey, templateData) pair into (subject, html, text). New
 * templates: add the import, the literal in @hireops/notifications'
 * TemplateKey union, and a case here.
 *
 * Subject lines are owned by the registry, not the caller — keeps
 * copy editable in one place.
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
        subject: `Application received — ${props.positionTitle}`,
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
    default: {
      // Exhaustiveness guard — adding a TemplateKey without a case fails here.
      const _exhaustive: never = key;
      void _exhaustive;
      throw new Error(`No template registered for key=${key as string}`);
    }
  }
}
