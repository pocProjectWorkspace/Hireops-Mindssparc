import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";
import type { ButtonSize, ButtonVariant } from "./Button";

const meta: Meta<typeof Button> = {
  title: "Primitives/Button",
  component: Button,
  parameters: { layout: "centered" },
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "secondary", "tertiary", "destructive"],
    },
    size: { control: "select", options: ["sm", "md", "lg"] },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
    fullWidth: { control: "boolean" },
  },
  args: {
    children: "Button",
    variant: "primary",
    size: "md",
  },
};

export default meta;

type Story = StoryObj<typeof Button>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary" } };
export const Tertiary: Story = { args: { variant: "tertiary" } };
export const Destructive: Story = { args: { variant: "destructive" } };

export const SmallSize: Story = { args: { size: "sm", children: "Small" } };
export const MediumSize: Story = { args: { size: "md", children: "Medium" } };
export const LargeSize: Story = { args: { size: "lg", children: "Large" } };

export const Loading: Story = { args: { loading: true } };
export const Disabled: Story = { args: { disabled: true } };
export const FullWidth: Story = {
  args: { fullWidth: true },
  decorators: [
    (StoryFn) => (
      <div style={{ width: 400 }}>
        <StoryFn />
      </div>
    ),
  ],
};

export const AllVariantsAndSizes: Story = {
  parameters: { layout: "padded" },
  render: () => {
    const variants: ButtonVariant[] = ["primary", "secondary", "tertiary", "destructive"];
    const sizes: ButtonSize[] = ["sm", "md", "lg"];
    return (
      <div
        style={{
          display: "grid",
          gap: "1rem",
          gridTemplateColumns: "auto 1fr 1fr 1fr",
          alignItems: "center",
        }}
      >
        <div />
        {sizes.map((s) => (
          <div key={s} style={{ fontFamily: "var(--font-family-mono)", fontSize: 12 }}>
            {s}
          </div>
        ))}
        {variants.map((v) => (
          <Row key={v} variant={v} sizes={sizes} />
        ))}
      </div>
    );
  },
};

function Row({ variant, sizes }: { variant: ButtonVariant; sizes: ButtonSize[] }) {
  return (
    <>
      <div style={{ fontFamily: "var(--font-family-mono)", fontSize: 12 }}>{variant}</div>
      {sizes.map((s) => (
        <div key={s}>
          <Button variant={variant} size={s}>
            Action
          </Button>
        </div>
      ))}
    </>
  );
}

export const AllStates: Story = {
  parameters: { layout: "padded" },
  render: () => (
    <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
      <Button>Default</Button>
      <Button disabled>Disabled</Button>
      <Button loading>Loading</Button>
    </div>
  ),
};
