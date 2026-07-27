import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["graphql"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/onchainProjectionVerifier.test.ts"],
  },
});
