// jest-dom's matchers are registered at runtime in src/test/setup.ts. This
// pulls their type declarations into the project so `toBeInTheDocument` and
// friends type-check in .test.tsx files.
import "@testing-library/jest-dom/vitest";
