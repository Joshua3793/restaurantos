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
        'ink-4':     '#a1a1aa',
        // Borders
        line:        '#e4e4e7',
        'line-2':    '#d4d4d8',
        // Brand accent — amber (use sparingly)
        gold:        '#d97706',
        'gold-2':    '#b45309',   // text-safe on light bg
        'gold-soft': '#fef3c7',
        // Semantic data colors (consistent with Tailwind defaults for fallback)
        red:           '#dc2626',  // red-600
        'red-soft':    '#fee2e2',  // red-100
        'red-text':    '#b91c1c',  // red-700
        green:         '#16a34a',  // green-600
        'green-soft':  '#dcfce7',  // green-100
        'green-text':  '#15803d',  // green-700
        blue:          '#2563eb',  // blue-600
        'blue-soft':   '#dbeafe',  // blue-100
        'blue-text':   '#1d4ed8',  // blue-700
        // ── Legacy (keep during migration) ─────────────────────────────────
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        fraunces: ['var(--font-fraunces)', 'Fraunces', 'ui-serif', 'Georgia', 'serif'],
      },
      borderRadius: {
        // Brand radius scale (Brand Summary §04 — "tight radii"): r-sm 7 · r 9 · r-md 10 · r-lg 12 · r-xl 14
        sm:  '7px',
        DEFAULT: '9px',
        md:  '10px',
        lg:  '12px',
        xl:  '14px',
        '2xl': '18px',
        '3xl': '22px',
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
