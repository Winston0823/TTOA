import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["ui-rounded", "SF Pro Rounded", "Nunito", "system-ui", "sans-serif"],
      },
      colors: {
        deep: "#0b2e33",
        teal: "#1f7a80",
        foam: "#f4ede0",
        coral: "#ff6b4a",
        amber: "#ffb43d",
      },
    },
  },
  plugins: [],
};
export default config;
