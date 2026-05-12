import type { Preview } from "@storybook/react-vite";
import "../src/tokens.css";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "page",
      values: [
        { name: "page", value: "#fafafa" },
        { name: "white", value: "#ffffff" },
        { name: "dark", value: "#171717" },
      ],
    },
    layout: "centered",
  },
};

export default preview;
