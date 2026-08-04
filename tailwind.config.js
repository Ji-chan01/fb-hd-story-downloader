/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./public/**/*.html", "./public/**/*.js", "./*.html", "./js/**/*.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Inter Fallback", "system-ui", "sans-serif"],
        serif: ["Lora", "Lora Fallback", "ui-serif", "Georgia", "serif"],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
      },
      colors: {
        // shadcn-style semantic tokens, driven by CSS variables so
        // light/dark mode just works via the `.dark` class
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },

        // Brand palette (static hex, independent of light/dark mode)
        gold: {
          50: "#FBF8F1",
          100: "#F5EBD0",
          200: "#EDD79C",
          300: "#E0BC67",
          400: "#C9A14B",
          500: "#A88438",
          600: "#84682B",
          700: "#5D4A1F",
          800: "#3D3015",
          900: "#1F180A",
        },
        navy: {
          50: "#F1F4F9",
          100: "#DAE2EF",
          200: "#B4C5DE",
          300: "#8AA3C5",
          400: "#5E7CA5",
          500: "#3D5C86",
          700: "#1B2D4E",
          800: "#101D34",
          900: "#08111F",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        goldGlow: "0 0 8px rgba(224, 188, 103, 0.6)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: 0 },
          "100%": { opacity: 1 },
        },
        "fade-in-up": {
          "0%": { opacity: 0, transform: "translateY(12px)" },
          "100%": { opacity: 1, transform: "translateY(0)" },
        },
        "vip-shimmer": {
          "0%, 100%": {
            color: "#C9A14B",
            filter: "drop-shadow(0 0 0 rgba(224,188,103,0))",
          },
          "50%": {
            color: "#E0BC67",
            filter: "drop-shadow(0 0 4px rgba(224,188,103,.75))",
          },
        },
        "vip-neon-rotate": {
          "0%": { "--angle": "0deg" },
          "100%": { "--angle": "360deg" },
        },
      },
      animation: {
        "fade-in": "fade-in .4s ease-out",
        "fade-in-up": "fade-in-up .35s ease-out",
        "vip-shimmer": "vip-shimmer 2.4s ease-in-out infinite",
        "vip-neon-rotate": "vip-neon-rotate 4s linear infinite",
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
};
