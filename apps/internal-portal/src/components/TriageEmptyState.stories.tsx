import type { Meta, StoryObj } from "@storybook/react-vite";
import { TriageEmptyState } from "./TriageEmptyState";

const meta = {
  title: "Pages/Triage Empty State",
  component: TriageEmptyState,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TriageEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoCandidates: Story = {};
