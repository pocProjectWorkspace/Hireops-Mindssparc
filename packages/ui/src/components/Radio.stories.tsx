import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { RadioGroup, RadioGroupItem } from "./Radio";
import { Input } from "./Input";
import { Button } from "./Button";

const meta: Meta<typeof RadioGroup> = {
  title: "Primitives/Radio",
  component: RadioGroup,
  parameters: { layout: "centered" },
  argTypes: {
    orientation: { control: "select", options: ["vertical", "horizontal"] },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
  },
  args: {
    label: "Engagement type",
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

type Story = StoryObj<typeof RadioGroup>;

const engagementOptions = [
  { value: "fulltime", label: "Full-time" },
  { value: "contract", label: "Contract" },
  { value: "intern", label: "Intern" },
];

export const Default: Story = {
  render: (args) => (
    <RadioGroup {...args}>
      {engagementOptions.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  ),
};

export const WithDefaultValue: Story = {
  args: { defaultValue: "contract" },
  render: (args) => (
    <RadioGroup {...args}>
      {engagementOptions.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  ),
};

export const Horizontal: Story = {
  args: { orientation: "horizontal" },
  render: (args) => (
    <RadioGroup {...args}>
      {engagementOptions.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  ),
};

export const WithHint: Story = {
  args: { hint: "We use this for default screening questions." },
  render: (args) => (
    <RadioGroup {...args}>
      {engagementOptions.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  ),
};

export const WithError: Story = {
  args: { error: "Pick one to continue." },
  render: (args) => (
    <RadioGroup {...args}>
      {engagementOptions.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  ),
};

export const Required: Story = {
  args: { required: true },
  render: (args) => (
    <RadioGroup {...args}>
      {engagementOptions.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  ),
};

export const DisabledGroup: Story = {
  args: { disabled: true, defaultValue: "fulltime" },
  render: (args) => (
    <RadioGroup {...args}>
      {engagementOptions.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  ),
};

export const DisabledItem: Story = {
  render: (args) => (
    <RadioGroup {...args}>
      <RadioGroupItem value="fulltime" label="Full-time" />
      <RadioGroupItem value="contract" label="Contract" />
      <RadioGroupItem value="intern" label="Intern (closed)" disabled />
    </RadioGroup>
  ),
};

export const Controlled: Story = {
  render: function Render(args) {
    const [v, setV] = useState<string>("");
    return (
      <RadioGroup
        {...args}
        value={v}
        onValueChange={setV}
        hint={v ? `Selected: ${v}` : "No selection yet."}
      >
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
    );
  },
};

export const AllStates: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <div style={{ display: "grid", gap: "1.5rem", gridTemplateColumns: "320px 320px" }}>
      <RadioGroup label="Default">
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
      <RadioGroup label="Preselected" defaultValue="contract">
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
      <RadioGroup label="With hint" hint="A useful detail.">
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
      <RadioGroup label="With error" error="Pick one to continue.">
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
      <RadioGroup label="Required" required>
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
      <RadioGroup label="Disabled" disabled defaultValue="fulltime">
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
    </div>
  ),
};

export const ComposedJobForm: Story = {
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
      <Input label="Role title" placeholder="Backend Engineer" />
      <RadioGroup label="Engagement type" defaultValue="fulltime">
        {engagementOptions.map((o) => (
          <RadioGroupItem key={o.value} value={o.value} label={o.label} />
        ))}
      </RadioGroup>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button variant="secondary">Cancel</Button>
        <Button variant="primary">Create</Button>
      </div>
    </div>
  ),
};
