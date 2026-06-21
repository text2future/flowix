/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/flowix-web/**/*.{html,js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /* shadcn/ui compatible variable references */
        background: "var(--background)",
        foreground: "var(--foreground)",
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",

        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
      },
      fontSize: {
        '2xs': '0.6875rem',
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
      },
    },
  },
  plugins: [],
};
