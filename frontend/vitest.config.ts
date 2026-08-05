import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same reason as vite.config.ts: the vendored converter imports dompurify
  // by bare specifier from outside this package.
  resolve: {
    alias: {
      dompurify: fileURLToPath(
        new URL("node_modules/dompurify", import.meta.url),
      ),
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/vitest-setup.ts"],
    env: {
      VITE_API_URL: "http://localhost:8788",
    },
    server: {
      deps: {
        inline: ["foldkit", "@foldkit/ui", "@foldkit/devtools"],
      },
    },
  },
});
