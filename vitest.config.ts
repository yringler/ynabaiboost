// vitest.config.ts — three projects (DESIGN §13):
//   unit   : node pool — pure domain (test/unit/**) and shared code (test/shared/**)
//   worker : Workers runtime via @cloudflare/vitest-plugin, D1 migrations applied per test file (test/worker/**)
//   client : jsdom + Testing Library (test/client/**, src/client/**/*.test.tsx)
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test-only secret values (wrangler reads required secrets from process.env; avoids "missing secrets" warnings).
const TEST_SECRETS = {
  ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // 32 zero bytes, base64
  SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  YNAB_CLIENT_SECRET: "disabled",
};
for (const [k, v] of Object.entries(TEST_SECRETS)) process.env[k] ??= v;

const sharedAlias = { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts", "test/shared/**/*.test.ts"],
        },
      },
      {
        resolve: { alias: sharedAlias },
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            remoteBindings: false, // the AI binding is remote-only; tests stub it (no Cloudflare credentials in CI)
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
                APP_ORIGIN: "https://app.test",
                ...TEST_SECRETS,
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["./test/setup/apply-migrations.ts"],
          // ynab@5 pulls in fetch-ponyfill → node-fetch (CJS with an optional "encoding" peer); pre-bundle it.
          deps: { optimizer: { ssr: { enabled: true, include: ["ynab"] } } },
        },
      },
      {
        resolve: { alias: sharedAlias },
        plugins: [react()],
        test: {
          name: "client",
          environment: "jsdom",
          include: ["test/client/**/*.test.{ts,tsx}", "src/client/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
