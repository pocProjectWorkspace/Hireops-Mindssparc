import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Switch } from "./Switch";

const meta: Meta<typeof Switch> = {
  title: "Primitives/Switch",
  component: Switch,
  parameters: { layout: "centered" },
  args: {
    label: "Notifications enabled",
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

type Story = StoryObj<typeof Switch>;

export const Default: Story = {};

export const Checked: Story = { args: { defaultChecked: true } };

export const WithHint: Story = {
  args: { hint: "Toggles digest emails immediately." },
};

export const WithError: Story = {
  args: { error: "Toggle this on to continue." },
};

export const Required: Story = { args: { required: true } };

export const Disabled: Story = { args: { disabled: true } };

export const DisabledChecked: Story = {
  args: { disabled: true, defaultChecked: true },
};

export const Controlled: Story = {
  render: function Render(args) {
    const [on, setOn] = useState(false);
    return (
      <Switch
        {...args}
        checked={on}
        onCheckedChange={setOn}
        hint={`Currently ${on ? "on" : "off"}.`}
      />
    );
  },
};

export const AllStates: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "260px 260px" }}>
      <Switch label="Default" />
      <Switch label="On" defaultChecked />
      <Switch label="With hint" hint="Effect is immediate." />
      <Switch label="With error" error="Required to proceed." />
      <Switch label="Required" required />
      <Switch label="Disabled" disabled />
      <Switch label="Disabled + on" disabled defaultChecked />
    </div>
  ),
};

export const ComposedSettings: Story = {
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
      <p
        style={{
          margin: 0,
          fontSize: "var(--font-size-md)",
          fontWeight: 600,
          color: "var(--color-neutral-800)",
        }}
      >
        Notifications
      </p>
      <Switch label="New applicant alerts" defaultChecked />
      <Switch label="Interview reminders" defaultChecked />
      <Switch label="Weekly digest" />
      <Switch label="SMS alerts (paid tier)" disabled />
    </div>
  ),
};
