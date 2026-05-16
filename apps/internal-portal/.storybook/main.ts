import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";

function getAbsolutePath(value: string): string {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`)));
}

/**
 * App-local Storybook. Same Vite-based framework as packages/ui — the
 * app uses Next.js at runtime, but Storybook renders stories in
 * isolation so we don't need the Next adapter. Stories cover
 * presentational components (LoginForm, TriageEmptyState, TriageRow);
 * server-component pages aren't story-friendly and stay out.
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  addons: [
    getAbsolutePath("@chromatic-com/storybook"),
    getAbsolutePath("@storybook/addon-a11y"),
    getAbsolutePath("@storybook/addon-docs"),
  ],
  framework: getAbsolutePath("@storybook/react-vite"),
};

export default config;
