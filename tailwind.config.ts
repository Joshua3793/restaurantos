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
        // ── Design system tokens (Implementation.html) ─────────────────────
        // Surfaces
        bg:          '#fafaf9',
        'bg-2':      '#f4f4f5',
        paper:       '#ffffff',
        // Ink scale
        ink:         '#09090b',
        'ink-2':     '#27272a',
        'ink-3':     '#71717a',
        // Borders
        line:        '#e4e4e7',
        'line-2':    '#d4d4d8',
        // Brand accent — amber (use sparingly)
        gold:        '#d97706',
        'gold-2':    '#b45309',   // text-safe on light bg
        'gold-soft': '#fef3c7',
        // ── Legacy (keep during migration) ─────────────────────────────────
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm:  '6px',
        DEFAULT: '8px',
        md:  '10px',
        lg:  '12px',
        xl:  '16px',
        '2xl': '20px',
        '3xl': '24px',
        full: '9999px',
      },
      fontSize: {
        label:   ['10.5px', { letterSpacing: '0.08em',  lineHeight: '1.2' }],
        caption: ['11.5px', { lineHeight: '1.45' }],
        body:    ['13.5px', { lineHeight: '1.55' }],
        h2:      ['17px',   { lineHeight: '1.3',  fontWeight: '600' }],
        h1:      ['28px',   { lineHeight: '1.1',  letterSpacing: '-0.01em', fontWeight: '600' }],
        display: ['56px',   { lineHeight: '1',    letterSpacing: '-0.02em' }],
      },
    },
  },
  plugins: [],
};

export default config;
