import type { Meta, StoryObj } from "@storybook/react-vite";
import { AIScoreBadge } from "./AIScoreBadge";

const meta = {
  title: "Triage/AI Score Badge",
  component: AIScoreBadge,
  parameters: { layout: "padded" },
} satisfies Meta<typeof AIScoreBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleExplanation = {
  top_factors: [
    { label: "Python", weight: 0.32, description: "8 years matching the JD" },
    { label: "AWS", weight: 0.18 },
    { label: "Lead experience", weight: 0.12 },
  ],
  model: "claude-sonnet-4-6",
};

export const CardHighScore: Story = {
  args: { score: 88, explanation: sampleExplanation, variant: "card" },
};

export const CardNoExplanation: Story = {
  args: { score: 62, explanation: null, variant: "card" },
};

export const CardNoScore: Story = {
  args: { score: null, explanation: null, variant: "card" },
};

export const DrawerFullExplanation: Story = {
  args: { score: 88, explanation: sampleExplanation, variant: "drawer" },
};
