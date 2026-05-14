import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Select } from "./Select";
import type { SelectOption, SelectSize } from "./Select";
import { Input } from "./Input";
import { Button } from "./Button";

const roleOptions: SelectOption[] = [
  { value: "swe", label: "Software Engineer" },
  { value: "pm", label: "Product Manager" },
  { value: "designer", label: "Designer" },
  { value: "data", label: "Data Scientist" },
  { value: "ops", label: "Operations" },
  { value: "exec", label: "Executive" },
  { value: "intern", label: "Intern", disabled: true },
];

const seniorityOptions: SelectOption[] = [
  { value: "junior", label: "Junior" },
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "staff", label: "Staff" },
  { value: "principal", label: "Principal" },
];

const meta: Meta<typeof Select> = {
  title: "Primitives/Select",
  component: Select,
  parameters: { layout: "centered" },
  argTypes: {
    size: { control: "select", options: ["sm", "md"] },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
  },
  args: {
    label: "Role",
    options: roleOptions,
    placeholder: "Select a role",
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

type Story = StoryObj<typeof Select>;

export const Default: Story = {};

export const WithHint: Story = {
  args: { hint: "Used for default screening questions." },
};

export const WithError: Story = {
  args: { error: "Pick one to continue." },
};

export const Required: Story = {
  args: { required: true },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "swe" },
};

export const Preselected: Story = {
  args: { defaultValue: "pm" },
};

export const Controlled: Story = {
  render: function Render(args) {
    const [v, setV] = useState<string>("");
    return (
      <Select
        {...args}
        value={v}
        onValueChange={setV}
        hint={v ? `Selected: ${v}` : "No selection yet."}
      />
    );
  },
};

export const VariantsAndSizes: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => {
    const sizes: SelectSize[] = ["sm", "md"];
    return (
      <div
        style={{
          display: "grid",
          gap: "1rem",
          gridTemplateColumns: "auto repeat(2, 240px)",
          alignItems: "end",
        }}
      >
        <div />
        {sizes.map((s) => (
          <div key={s} style={{ fontFamily: "var(--font-family-mono)", fontSize: 12 }}>
            {s}
          </div>
        ))}
        <div style={{ fontFamily: "var(--font-family-mono)", fontSize: 12 }}>default</div>
        {sizes.map((s) => (
          <Select key={`d-${s}`} size={s} options={roleOptions} placeholder="Select…" />
        ))}
        <div style={{ fontFamily: "var(--font-family-mono)", fontSize: 12 }}>preselected</div>
        {sizes.map((s) => (
          <Select key={`p-${s}`} size={s} options={roleOptions} defaultValue="swe" />
        ))}
        <div style={{ fontFamily: "var(--font-family-mono)", fontSize: 12 }}>disabled</div>
        {sizes.map((s) => (
          <Select key={`x-${s}`} size={s} options={roleOptions} defaultValue="pm" disabled />
        ))}
      </div>
    );
  },
};

export const AllStates: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "320px 320px" }}>
      <Select label="Default" options={roleOptions} placeholder="Select…" />
      <Select label="With hint" options={roleOptions} hint="A useful detail." />
      <Select label="Required" options={roleOptions} required />
      <Select label="With error" options={roleOptions} error="Pick one to continue." />
      <Select label="Disabled" options={roleOptions} defaultValue="swe" disabled />
      <Select label="Preselected" options={roleOptions} defaultValue="data" />
    </div>
  ),
};

export const ComposedSearchPanel: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <div
      style={{
        width: 520,
        padding: "var(--space-6)",
        background: "white",
        boxShadow: "var(--elevation-1)",
        borderRadius: "var(--radius-md)",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "var(--space-4)",
      }}
    >
      <Input label="Keyword" placeholder="React, fintech…" />
      <Select label="Role" options={roleOptions} placeholder="Any role" />
      <Select label="Seniority" options={seniorityOptions} placeholder="Any level" />
      <div style={{ display: "flex", alignItems: "end" }}>
        <Button variant="primary" fullWidth>
          Search
        </Button>
      </div>
    </div>
  ),
};
