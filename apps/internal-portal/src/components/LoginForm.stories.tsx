import type { Meta, StoryObj } from "@storybook/react-vite";
import { LoginForm } from "./LoginForm";

const meta = {
  title: "Pages/Login",
  component: LoginForm,
  parameters: { layout: "padded" },
} satisfies Meta<typeof LoginForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default LoginForm — empty state, no in-flight submission, no error.
 * The form's submit handler hits the real Supabase browser client
 * inside Storybook (which lacks env vars), so submitting from the
 * story will throw. That's expected for a Storybook render — the
 * story exists to verify visual + accessibility, not auth wiring.
 */
export const Empty: Story = {};
