import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The Workers AI binding is remote-only, so `npm run dev` needs `npx wrangler login`.
// Set CF_LOCAL_ONLY=1 to start without Cloudflare credentials (env.AI calls then fail; everything else works).
const localOnly = process.env.CF_LOCAL_ONLY === "1";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ remoteBindings: !localOnly })],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) },
  },
});
