import type { Preview } from "@storybook/react-vite";
// Tokens first, then the app's Tailwind layer so utilities resolve
// the CSS-var references. globals.css imports tokens.css too; this
// double-import is harmless (CSS deduplicates on @import URL).
import "@hireops/ui/src/tokens.css";
import "../src/styles/globals.css";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "page",
      values: [
        { name: "page", value: "#fafafa" },
        { name: "white", value: "#ffffff" },
      ],
    },
    layout: "centered",
  },
};

export default preview;
