// Shared setup for every test file.
//
// Runs in the `node` environment too, so everything here must be guarded — a
// pure-logic test must not pay for, or fail because of, DOM scaffolding.

import { afterEach, expect } from "vitest";

const hasDom = typeof window !== "undefined" && typeof document !== "undefined";

if (hasDom) {
  const matchers = await import("@testing-library/jest-dom/matchers");
  const { cleanup } = await import("@testing-library/react");
  expect.extend(matchers.default ?? matchers);
  afterEach(() => cleanup());

  // jsdom implements neither of these, and the Report reads both: the chart
  // checks prefers-reduced-motion before animating, and Recharts measures its
  // container. Without them a render test fails on a missing API rather than on
  // the behaviour it is actually asserting.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}
