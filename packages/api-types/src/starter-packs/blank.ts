import type { StarterPack } from "./types";

/**
 * `blank` — platform defaults only. Lays down no configuration rows and no
 * settings blocks: every resolver falls back to its code default, every
 * module takes the platform default (enabled). For a client whose setup is
 * built from scratch in the setup wizard, or imported from a config file.
 */
export const BLANK_STARTER_PACK: StarterPack = {
  key: "blank",
  version: 1,
  label: "Blank (platform defaults)",
  description:
    "No starter configuration. Every setting uses the platform default and every module is on. Build the setup in the wizard or import a configuration file.",
  modules: {},
  defaultRegion: "ap-south-1",
  config: {},
};
