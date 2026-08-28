import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

// The seven surfaces reachable from the sidebar. `briefing` and `versions` are
// deliberately absent: they are sub-surfaces of Projects, entered by drilling
// into a project, so they need capture data the browser preview does not have.
const NAV_SURFACES = [
  { id: "projects", label: "Projects" },
  { id: "recap", label: "Report" },
  { id: "timeline", label: "Timeline" },
  { id: "organizer", label: "Organizer" },
  { id: "planner", label: "Planner" },
  { id: "notes", label: "Notes" },
  { id: "glossary", label: "Reference" },
] as const;

// Errors tolerated because they are a consequence of running outside Tauri
// rather than a real defect. Empty on purpose: the browser-preview path in
// App.tsx bails out of every native call before it can throw, so a clean boot
// really does produce zero console errors. Anything that shows up here is a
// regression. Resist widening this to a pattern like /tauri/i — that would
// swallow genuine failures in the code paths most likely to break.
const EXPECTED_WITHOUT_TAURI: RegExp[] = [];

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (EXPECTED_WITHOUT_TAURI.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => {
    errors.push(`uncaught: ${error.message}`);
  });
  return errors;
}

/**
 * The sidebar's nav item, scoped to the nav container.
 *
 * Scoping matters: the sidebar also carries a "Report a problem" button, so an
 * unscoped /^Report/ matches two elements and trips strict mode.
 */
function navButton(page: Page, label: string) {
  return page
    .locator(".recall-sidebar__nav")
    .getByRole("button", { name: new RegExp(`^${label}`) });
}

/** Boot the app and cross the startup screen into the shell. */
async function enterStudio(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Project Desk" }).click();
  await expect(page.locator(".recall-app")).toBeVisible();
}

test.describe("startup", () => {
  test("renders the startup screen with the studio profile form", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto("/");

    await expect(page.locator("main.startup-screen")).toBeVisible();
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Project Desk" })).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test("entering the desk reveals the shell and its full nav", async ({ page }) => {
    const errors = watchConsole(page);
    await enterStudio(page);

    // The startup screen must actually be gone, not just covered.
    await expect(page.locator("main.startup-screen")).toHaveCount(0);

    for (const { label } of NAV_SURFACES) {
      await expect(navButton(page, label)).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
});

test.describe("surfaces", () => {
  for (const { id, label } of NAV_SURFACES) {
    test(`${id} renders when selected from the nav`, async ({ page }) => {
      const errors = watchConsole(page);
      await enterStudio(page);

      await navButton(page, label).click();

      // The Organizer stays mounted and merely hidden when inactive
      // (AppShell.tsx:176), so presence in the DOM proves nothing here —
      // visibility is the assertion that actually distinguishes the surfaces.
      const stage = page.locator(`.recall-surface-stage[data-surface="${id}"]`);
      await expect(stage).toBeVisible();
      await expect(stage).not.toBeEmpty();

      // And the nav must agree about where we are.
      await expect(navButton(page, label)).toHaveAttribute("aria-current", "page");

      expect(errors).toEqual([]);
    });
  }

  test("a full tour of every surface leaves no console errors behind", async ({ page }) => {
    const errors = watchConsole(page);
    await enterStudio(page);

    for (const { id, label } of NAV_SURFACES) {
      await navButton(page, label).click();
      await expect(
        page.locator(`.recall-surface-stage[data-surface="${id}"]`),
      ).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
});
