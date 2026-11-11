import type { Meta, StoryObj } from "@storybook/react-vite";
import { TriageCard } from "./TriageCard";

const meta = {
  title: "Triage/Triage Card",
  component: TriageCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TriageCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseRow = {
  candidateId: "00000000-0000-4000-8000-000000000001",
  applicationId: "00000000-0000-4000-8000-000000000002",
  fullName: "Maya Singh",
  email: "maya.singh@example.com",
  source: "career_site" as const,
  stage: "application_received" as const,
  stageEnteredAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(), // 6h ago
  aiScore: 88,
  aiScoreExplanation: {
    top_factors: [{ label: "Python" }, { label: "AWS" }, { label: "Lead experience" }],
  },
  evidenceSummary: null,
  createdAt: new Date().toISOString(),
  screening: {
    noticePeriodDays: 60,
    noticePeriodFrom: "application" as const,
    currentSalaryInrPaise: 1_200_000_00,
    expectedSalaryInrPaise: 1_500_000_00,
    currentLocation: "Pune",
    source: "candidate" as const,
    updatedAt: new Date().toISOString(),
    compVisible: true,
  },
  knockout: {
    passed: null,
    failCount: 0,
    unknownCount: 1,
    evaluatedAt: new Date().toISOString(),
    items: [
      {
        knockoutId: "k1",
        fieldPath: "expected_ctc",
        label: "Expected CTC within band",
        result: "unknown" as const,
        reason: "field_missing",
      },
    ],
  },
};

export const FeedVariant: Story = {
  args: { row: baseRow, variant: "feed", onOpen: () => undefined },
};

export const BreachVariant: Story = {
  args: {
    row: {
      ...baseRow,
      // 48h in stage — SLA breach for application_received (24h)
      stageEnteredAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    },
    variant: "breach",
    onOpen: () => undefined,
  },
};

export const NoScore: Story = {
  args: {
    row: { ...baseRow, aiScore: null, aiScoreExplanation: null },
    variant: "feed",
    onOpen: () => undefined,
  },
};
