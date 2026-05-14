import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "./Card";
import type { CardVariant } from "./Card";
import { Input } from "./Input";
import { Button } from "./Button";

const meta: Meta<typeof Card> = {
  title: "Primitives/Card",
  component: Card,
  parameters: { layout: "padded" },
  argTypes: {
    variant: { control: "select", options: ["default", "hover", "ghost"] },
    as: { control: "select", options: ["div", "article", "section", "aside"] },
    padding: { control: "text" },
  },
  args: {
    variant: "default",
    children: (
      <div>
        <h3 style={{ margin: 0, fontSize: "var(--font-size-md)", fontWeight: 600 }}>
          Candidate summary
        </h3>
        <p style={{ marginTop: "var(--space-2)", color: "var(--color-neutral-600)" }}>
          5 years of experience in distributed systems, last role at Linear.
        </p>
      </div>
    ),
  },
  decorators: [
    (StoryFn) => (
      <div style={{ width: 360 }}>
        <StoryFn />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Card>;

export const Default: Story = {};

export const Hover: Story = { args: { variant: "hover" } };

export const Ghost: Story = { args: { variant: "ghost" } };

export const CustomPadding: Story = {
  args: { padding: "var(--space-3)" },
};

export const NoPadding: Story = {
  args: { padding: "0" },
};

export const AsArticle: Story = {
  args: { as: "article" },
};

export const Variants: Story = {
  decorators: [(StoryFn) => <StoryFn />],
  render: () => {
    const variants: CardVariant[] = ["default", "hover", "ghost"];
    return (
      <div style={{ display: "grid", gap: "1.5rem", gridTemplateColumns: "repeat(3, 280px)" }}>
        {variants.map((v) => (
          <div key={v}>
            <div
              style={{
                fontFamily: "var(--font-family-mono)",
                fontSize: 12,
                marginBottom: "var(--space-2)",
                color: "var(--color-neutral-500)",
              }}
            >
              {v}
            </div>
            <Card variant={v}>
              <h3 style={{ margin: 0, fontSize: "var(--font-size-md)", fontWeight: 600 }}>
                Headline
              </h3>
              <p
                style={{
                  marginTop: "var(--space-2)",
                  color: "var(--color-neutral-600)",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                Supporting copy for this surface.
              </p>
            </Card>
          </div>
        ))}
      </div>
    );
  },
};

export const ComposedSettingsCard: Story = {
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <Card variant="default">
      <h3 style={{ margin: 0, fontSize: "var(--font-size-md)", fontWeight: 600 }}>
        Workspace settings
      </h3>
      <p
        style={{
          marginTop: "var(--space-1)",
          marginBottom: "var(--space-4)",
          color: "var(--color-neutral-500)",
          fontSize: "var(--font-size-sm)",
        }}
      >
        Change how HireOps shows up in your candidate emails.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <Input label="Display name" placeholder="HireOps team" />
        <Input label="Reply-to email" type="email" placeholder="team@hireops.com" />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="secondary">Cancel</Button>
          <Button variant="primary">Save</Button>
        </div>
      </div>
    </Card>
  ),
};
