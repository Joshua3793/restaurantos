import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Brand gold — supports opacity modifiers: bg-gold/10, text-gold, border-gold/30, etc.
        gold: 'rgb(var(--gold) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
export default config;
