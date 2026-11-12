import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: { "vitest-environment-beni-jsdom": fileURLToPath(new URL("./src/frontend/test/jsdom-environment.mjs", import.meta.url)) },
  },
  test: { environment: "happy-dom", include: ["src/frontend/**/*.test.tsx"] },
});
