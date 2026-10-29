import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/preview-bench.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
