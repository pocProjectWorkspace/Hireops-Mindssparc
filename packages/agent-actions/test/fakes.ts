import type {
  AIDraftRequest,
  ApplicationContext,
  EnqueueEmailRequest,
  ExecutorDeps,
} from "../src/index";

/**
 * In-memory ExecutorDeps for the pure-package tests.
 *
 * The whole reason executors take ports (rather than importing
 * `@hireops/db` / `@hireops/ai-client`) is so this package can be tested
 * with no database, no network, and no LLM tokens. These fakes record
 * every call so tests can assert on what an executor asked for, not just
 * what it returned.
 */

export const FAKE_CONTEXT: ApplicationContext = {
  applicationId: "app-1",
  candidateId: "cand-1",
  candidateName: "Anika Sharma",
  candidateEmail: "anika@example.com",
  positionTitle: "Senior Backend Engineer",
  companyName: "Kyndryl GCC",
  stage: "tech_interview",
  daysInStage: 6,
  jdSummary: "Backend engineer for the payments platform.",
};

export interface FakeDeps extends ExecutorDeps {
  calls: {
    loadApplicationContext: { tenantId: string; applicationId: string }[];
    draftWithAI: { tenantId: string; req: AIDraftRequest }[];
    enqueueEmail: { tenantId: string; req: EnqueueEmailRequest }[];
  };
}

export interface FakeDepsOpts {
  context?: Partial<ApplicationContext>;
  draftText?: string;
  costMicros?: bigint;
  onLoadContext?: () => never;
  onDraft?: () => never;
  onEnqueue?: () => never;
}

export function makeFakeDeps(opts: FakeDepsOpts = {}): FakeDeps {
  const calls: FakeDeps["calls"] = {
    loadApplicationContext: [],
    draftWithAI: [],
    enqueueEmail: [],
  };

  return {
    calls,
    async loadApplicationContext(tenantId, applicationId) {
      calls.loadApplicationContext.push({ tenantId, applicationId });
      if (opts.onLoadContext) opts.onLoadContext();
      return { ...FAKE_CONTEXT, ...opts.context };
    },
    async draftWithAI(tenantId, req) {
      calls.draftWithAI.push({ tenantId, req });
      if (opts.onDraft) opts.onDraft();
      return {
        text: opts.draftText ?? "  Hi Anika,\n\nJust checking in.  ",
        costMicros: opts.costMicros ?? 1234n,
      };
    },
    async enqueueEmail(tenantId, req) {
      calls.enqueueEmail.push({ tenantId, req });
      if (opts.onEnqueue) opts.onEnqueue();
      return { outboxId: "outbox-1" };
    },
  };
}
