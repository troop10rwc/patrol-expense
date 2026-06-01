import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Mounted as a same-origin tab at troop10rwc.org/expenses.
  base: "/expenses/",
  plugins: [react(), cloudflare()],
});
