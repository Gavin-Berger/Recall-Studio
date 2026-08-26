import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two kinds of test, one runner.
//
// The bulk of the suite is pure logic — event classification, timeline
// formatting, report reconciliation — and those run fastest with no DOM at
// all. But the Report page now holds behaviour that only exists in the
// component: which step is showing, whether the evidence drawer traps focus,
// whether a filtered table tells a screen reader it is filtered. None of that
// is reachable from a `node` environment, and it is the one layer that cannot
// be retested by hand because doing so means driving Ableton.
//
// The default stays `node` so the logic suite never pays for a DOM. Render
// tests opt in per file with a `// @vitest-environment jsdom` docblock — the
// per-file form is what Vitest 4 supports; `environmentMatchGlobs` was removed.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
  },
});
