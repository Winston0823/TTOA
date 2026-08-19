import type { Config } from "tailwindcss";

/** Ink palette. Mirrors CONFIG.ink in lib/config.ts — keep the two in step. */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["ui-rounded", "SF Pro Rounded", "Nunito", "system-ui", "sans-serif"],
        /** HUD numerals only. See the note in `app/layout.tsx`. */
        hud: ["var(--font-hud)", "ui-rounded", "system-ui", "sans-serif"],
      },
      colors: {
        void: "#0d0722",
        deep: "#1b0f38",
        ink: "#2a1152",
        surface: "#8de8ff",
        splat: "#ff2d9b",
        gold: "#ffd23d",
        foam: "#f2ecff",
      },
    },
  },
  plugins: [],
};
export default config;
