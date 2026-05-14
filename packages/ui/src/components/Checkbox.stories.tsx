import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Checkbox } from "./Checkbox";
import { Input } from "./Input";

const meta: Meta<typeof Checkbox> = {
  title: "Primitives/Checkbox",
  component: Checkbox,
  parameters: { layout: "centered" },
  args: {
    label: "I agree to the terms",
  },
  decorators: [
    (StoryFn) => (
      <div style={{ width: 320 }}>
        <StoryFn />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Checkbox>;

export const Default: Story = {};

export const Checked: Story = { args: { defaultChecked: true } };

export const Indeterminate: Story = { args: { checked: "indeterminate" } };

export const WithHint: Story = {
  args: { hint: "You can change this later in settings." },
};

export const WithError: Story = {
  args: { error: "You must accept to proceed." },
};

export const Required: Story = { args: { required: true } };

export const Disabled: Story = { args: { disabled: true } };

export const DisabledChecked: Story = {
  args: { disabled: true, defaultChecked: true },
};

export const Controlled: Story = {
  render: function Render(args) {
    const [checked, setChecked] = useState<boolean | "indeterminate">(false);
    return (
      <Checkbox
        {...args}
        checked={checked}
        onCheckedChange={setChecked}
        hint={`Value: ${String(checked)}`}
      />
    );
  },
};

export const AllStates: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "240px 240px" }}>
      <Checkbox label="Default" />
      <Checkbox label="Checked" defaultChecked />
      <Checkbox label="Indeterminate" checked="indeterminate" />
      <Checkbox label="Required" required />
      <Checkbox label="With hint" hint="Optional context." />
      <Checkbox label="With error" error="Must be checked." />
      <Checkbox label="Disabled" disabled />
      <Checkbox label="Disabled + checked" disabled defaultChecked />
    </div>
  ),
};

export const ComposedPreferencesPanel: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <div
      style={{
        width: 480,
        padding: "var(--space-6)",
        background: "white",
        boxShadow: "var(--elevation-1)",
        borderRadius: "var(--radius-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
      }}
    >
      <Input label="Job title" placeholder="Senior Engineer" />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <p style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, margin: 0 }}>
          Notify me about
        </p>
        <Checkbox label="New applicants" defaultChecked />
        <Checkbox label="Interview reminders" defaultChecked />
        <Checkbox label="Weekly digest" />
      </div>
    </div>
  ),
};
