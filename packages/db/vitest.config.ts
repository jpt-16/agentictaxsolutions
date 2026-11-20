import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/testing/global-setup.ts"],
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
