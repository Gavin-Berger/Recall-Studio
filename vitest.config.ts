import { defineConfig } from "vitest/config";

// Unit tests for pure logic (event classification, timeline formatting).
// These don't need a DOM — the functions under test are plain data transforms.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
