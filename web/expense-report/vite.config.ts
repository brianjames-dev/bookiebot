import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "../../src/bookiebot/reports/assets",
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: true,
    lib: {
      entry: "src/main.tsx",
      name: "BookieBotExpenseReport",
      formats: ["iife"],
      fileName: () => "expense-report-app.js",
      cssFileName: "expense-report-app",
    },
  },
})
