import { defineConfig, devices } from "@playwright/test";

// Browser-level smoke tests for the React layer.
//
// The unit suite (vitest) covers pure logic and a few jsdom render tests, but
// nothing exercised the app as an actually-painted document: routing between
// surfaces, CSS that only resolves in a real engine, effects that run on mount.
// That gap matters here more than in most apps because the alternative way to
// catch a blank screen is to drive Ableton by hand.
//
// This runs the Vite dev server directly rather than `tauri dev`. `isTauri()`
// is false in a plain browser, and App.tsx already treats that as a supported
// "local browser preview" path that marks the library ready with empty
// in-memory state (src/App.tsx:331). So the shell, the nav, and every surface's
// empty state are reachable without a Rust backend — which is exactly the layer
// these tests are for. Anything that needs real capture data stays in vitest.
export default defineConfig({
  testDir: "./e2e",
  // Deliberately serial. Every worker shares the one Vite dev server on the
  // strict port 1420, and a cold start has to transform the whole module graph
  // on demand — running these fully parallel put ~10 pages through that at once
  // and every single spec blew its 30s actionability timeout. Serial, the same
  // suite finishes in under 20s, so parallelism buys nothing here anyway.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },

  projects: [
    {
      // Chromium only, deliberately. Tauri on Windows renders through WebView2,
      // which is Chromium — testing Firefox/WebKit here would be testing engines
      // this app never actually ships on.
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
