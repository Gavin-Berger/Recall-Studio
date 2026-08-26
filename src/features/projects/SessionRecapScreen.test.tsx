// @vitest-environment jsdom

// Render tests for the Report walkthrough.
//
// These cover the layer that only exists in the component — which step is
// showing, whether the evidence drawer behaves like the modal it declares
// itself to be, whether a filtered table tells assistive tech it is filtered.
// None of it is reachable from the pure-logic suite, and none of it can be
// checked by hand without driving Ableton, so it had no net at all before.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRecapScreen } from "./SessionRecapScreen";
import { reportPreviewSessions, REPORT_PREVIEW_SESSION_ID } from "./sessionReportPreview";

// The screen calls the Tauri bridge for real sessions. The preview ids short
// circuit that path inside loadReport, but only under import.meta.env.DEV.
vi.mock("../../lib/schema/api", () => ({
  getNoteEdits: vi.fn(async () => []),
  getParameterChanges: vi.fn(async () => []),
  getProjectSchema: vi.fn(async () => null),
  getTimelineClipEvents: vi.fn(async () => []),
  listCreativeMoments: vi.fn(async () => []),
  loadSessionEvents: vi.fn(async () => { throw new Error("unused in preview mode"); }),
  materializeSessionSchema: vi.fn(async () => undefined),
}));

// Recharts needs real layout; jsdom gives it none. The chart is exercised by
// its own logic tests, so stubbing it here keeps these tests about the
// walkthrough rather than about a charting library's measurement behaviour.
vi.mock("./InteractiveReportChart", () => ({
  InteractiveReportChart: () => <div data-testid="chart-stub" />,
}));

// Canvas-backed, and jsdom has no canvas. Stubbing keeps the output readable;
// without it every run prints a wall of getContext() warnings.
vi.mock("./TrackConstellation", () => ({
  TrackConstellation: () => <div data-testid="constellation-stub" />,
}));

function renderReport() {
  return render(
    <SessionRecapScreen
      sessionId={REPORT_PREVIEW_SESSION_ID}
      sessions={reportPreviewSessions}
      onSelectSession={vi.fn()}
      onOpenTimeline={vi.fn()}
      onOpenProjects={vi.fn()}
    />,
  );
}

/** The report loads through a debounced timer; wait for the tabs to exist. */
async function reportReady() {
  return screen.findByRole("tab", { name: /the session/i }, { timeout: 4000 });
}

describe("report walkthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens on step 1 and says which question the step answers", async () => {
    renderReport();
    await reportReady();

    expect(screen.getByText(/step 1 of 5/i)).toBeInTheDocument();
    expect(screen.getByText(/what happened in this version\?/i)).toBeInTheDocument();
  });

  it("uses the ledger count for the score headline instead of raw session prose", async () => {
    renderReport();
    await reportReady();

    expect(screen.getByText(/you shaped 4 tracks across/i)).toBeInTheDocument();
    expect(screen.queryByText(/this session focused on/i)).not.toBeInTheDocument();
  });

  it("presents the capture mix as concise audit units", async () => {
    renderReport();
    await reportReady();

    const captureMix = screen.getByRole("region", { name: /capture mix/i });
    expect(within(captureMix).getByText(/where the .* changes came from/i)).toBeInTheDocument();
    expect(within(captureMix).getByText(/your hands/i)).toBeInTheDocument();
    expect(within(captureMix).getByText(/live observed/i)).toBeInTheDocument();
  });

  it("moves between steps with the arrow keys", async () => {
    const user = userEvent.setup();
    renderReport();
    const first = await reportReady();

    first.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByText(/step 2 of 5/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /how it went/i })).toHaveAttribute("aria-selected", "true");
  });

  it("wraps from the last step back to the first", async () => {
    const user = userEvent.setup();
    renderReport();
    const first = await reportReady();

    first.focus();
    await user.keyboard("{End}");
    expect(screen.getByText(/step 5 of 5/i)).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(/step 1 of 5/i)).toBeInTheDocument();
  });

  // The pointer used to be the literal string "Step 2". Reordering REPORT_TABS
  // would have left it pointing at the wrong step with no test to catch it.
  it("derives the next-step pointer from the tab order", async () => {
    renderReport();
    await reportReady();

    const chaptersIndex = screen.getByRole("tab", { name: /how it went/i });
    expect(chaptersIndex).toBeInTheDocument();
    expect(screen.getByText(/^Step 2 breaks the same session/)).toBeInTheDocument();
  });
});

describe("session score", () => {
  // The donuts this replaced drew `count / biggest count`, so the leader was
  // always a full ring and the shares could not be added up. Rendering the
  // panel and summing what it actually says is the only way to catch that
  // denominator drifting back.
  it("states each work area's share of the captured total, and the shares total 100", async () => {
    renderReport();
    await reportReady();

    const bars = screen.getAllByRole("button", { name: /% of the work captured in this version/i });
    expect(bars.length).toBeGreaterThan(0);

    const shares = bars.map((bar) => Number(/(\d+)% of the work/.exec(bar.getAttribute("aria-label") ?? "")![1]));
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(100);
    // Ranked, largest first.
    expect([...shares].sort((a, b) => b - a)).toEqual(shares);
  });

  it("leads with one labelled figure rather than an unlabelled numeral", async () => {
    renderReport();
    await reportReady();

    const score = screen.getByRole("region", { name: /what you made move/i });
    expect(within(score).getByText(/^tracks touched$/i)).toBeInTheDocument();
  });

  it("opens the evidence for the area whose bar was clicked", async () => {
    const user = userEvent.setup();
    renderReport();
    await reportReady();

    const [leader] = screen.getAllByRole("button", { name: /% of the work captured in this version/i });
    const area = /^([^,]+),/.exec(leader!.getAttribute("aria-label") ?? "")![1]!;
    await user.click(leader!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: area })).toBeInTheDocument();
  });
});

describe("evidence drawer", () => {
  async function openDrawer() {
    const user = userEvent.setup();
    renderReport();
    await reportReady();
    const card = await screen.findByRole("button", { name: /where your attention went/i });
    await user.click(card);
    return { user, dialog: await screen.findByRole("dialog") };
  }

  it("declares itself a modal and puts focus inside on open", async () => {
    const { dialog } = await openDrawer();

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("button", { name: /close evidence/i })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the card that opened it", async () => {
    const { user } = await openDrawer();
    const opener = screen.getByRole("button", { name: /where your attention went/i });

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  // Declaring aria-modal without trapping Tab is worse than not declaring it:
  // assistive tech announces a modal, then Tab walks out into the page behind.
  it("keeps Tab inside the dialog", async () => {
    const { user, dialog } = await openDrawer();

    for (let press = 0; press < 12; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

describe("work kinds", () => {
  it("explains what every kind counts, including the ones with no activity", async () => {
    const user = userEvent.setup();
    renderReport();
    await reportReady();
    await user.click(screen.getByRole("tab", { name: /where it landed/i }));

    // "Recording & performance" has no activity in the preview session. Its
    // definition still has to be readable — that is exactly when it is asked
    // for — and it must not be a tooltip on a disabled control.
    const card = screen.getByRole("button", { name: /recording & performance/i });
    expect(card).toBeEnabled();
    expect(
      within(card).getByText(/recording, capture, comping, or a performed clip or scene/i),
    ).toBeInTheDocument();
  });
});

describe("track table", () => {
  it("nests cells inside rows rather than orphaning them in a rowgroup", async () => {
    const user = userEvent.setup();
    renderReport();
    await reportReady();
    await user.click(screen.getByRole("tab", { name: /where it landed/i }));

    const table = screen.getByRole("table", { name: /tracks in this version/i });
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1);
    // Every cell must have a row ancestor; orphaned cells are the defect.
    for (const cell of within(table).getAllByRole("cell")) {
      expect(cell.closest('[role="row"]')).not.toBeNull();
    }
  });
});

describe("changes table", () => {
  it("tells assistive tech when it is showing a filtered subset", async () => {
    const user = userEvent.setup();
    renderReport();
    await reportReady();
    await user.click(screen.getByRole("tab", { name: /every change/i }));

    expect(screen.getByRole("table", { name: /every decision, oldest first/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /mixing/i }));

    expect(screen.queryByRole("table", { name: /every decision/i })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: /mixing decisions, oldest first/i })).toBeInTheDocument();
  });
});
