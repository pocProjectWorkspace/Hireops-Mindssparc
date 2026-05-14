import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "./Input";
import type { InputSize, InputType } from "./Input";
import { Button } from "./Button";

const meta: Meta<typeof Input> = {
  title: "Primitives/Input",
  component: Input,
  parameters: { layout: "centered" },
  argTypes: {
    type: {
      control: "select",
      options: ["text", "email", "tel", "number", "password", "search"],
    },
    size: { control: "select", options: ["sm", "md"] },
    disabled: { control: "boolean" },
    readOnly: { control: "boolean" },
    required: { control: "boolean" },
  },
  args: {
    label: "Full name",
    placeholder: "Ada Lovelace",
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

type Story = StoryObj<typeof Input>;

export const Default: Story = {};

export const WithHint: Story = {
  args: { hint: "Use the name on your government ID." },
};

export const WithError: Story = {
  args: { error: "This field is required.", defaultValue: "" },
};

export const Required: Story = {
  args: { required: true },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "ada@lovelace.dev" },
};

export const ReadOnly: Story = {
  args: { readOnly: true, defaultValue: "ada@lovelace.dev" },
};

export const WithPrefix: Story = {
  args: {
    label: "Salary",
    type: "number",
    prefix: <span className="font-mono">₹</span>,
    placeholder: "1200000",
  },
};

export const WithSuffix: Story = {
  args: {
    label: "Budget",
    type: "number",
    suffix: <span className="font-mono text-xs">/ year</span>,
    placeholder: "1200000",
  },
};

export const Password: Story = {
  args: { label: "Password", type: "password", placeholder: "••••••••" },
};

export const Search: Story = {
  args: { label: "Search candidates", type: "search", placeholder: "Try a skill or name" },
};

export const VariantsAndSizes: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => {
    const types: InputType[] = ["text", "email", "tel", "number", "password", "search"];
    const sizes: InputSize[] = ["sm", "md"];
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
        {types.map((t) => (
          <Row key={t} type={t} sizes={sizes} />
        ))}
      </div>
    );
  },
};

function Row({ type, sizes }: { type: InputType; sizes: InputSize[] }) {
  return (
    <>
      <div style={{ fontFamily: "var(--font-family-mono)", fontSize: 12 }}>{type}</div>
      {sizes.map((s) => (
        <div key={s}>
          <Input type={type} size={s} placeholder={type} />
        </div>
      ))}
    </>
  );
}

export const AllStates: Story = {
  parameters: { layout: "padded" },
  decorators: [(StoryFn) => <StoryFn />],
  render: () => (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "320px 320px" }}>
      <Input label="Default" placeholder="text" />
      <Input label="With hint" placeholder="text" hint="Helpful detail goes here." />
      <Input label="Required" required placeholder="text" />
      <Input label="With error" error="Looks invalid." defaultValue="bad value" />
      <Input label="Disabled" disabled defaultValue="locked" />
      <Input label="Read only" readOnly defaultValue="ada@lovelace.dev" />
    </div>
  ),
};

export const ComposedSettingsPanel: Story = {
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
      <Input label="Display name" required placeholder="HireOps team" />
      <Input
        label="Contact email"
        type="email"
        required
        hint="Notifications and digests are sent here."
        placeholder="team@hireops.com"
      />
      <Input
        label="Hourly rate"
        type="number"
        prefix={<span className="font-mono">₹</span>}
        suffix={<span className="font-mono text-xs">/ hr</span>}
        placeholder="2500"
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button variant="secondary">Cancel</Button>
        <Button variant="primary">Save</Button>
      </div>
    </div>
  ),
};
