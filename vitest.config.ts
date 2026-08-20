import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AGENT_API_KEY: "test-master-key",
          EMAIL_DOMAIN: "mail.example.com",
          MCP_HOSTNAME: "mailbox.example.com",
        },
      },
    }),
  ],
});
