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
import { ReportLoading, SessionRecapScreen } from "./SessionRecapScreen";
import { reportPreviewSessions, REPORT_PREVIEW_SESSION_ID } from "./sessionReportPreview";

const { createPlannerTaskMock } = vi.hoisted(() => ({ createPlannerTaskMock: vi.fn() }));

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

vi.mock("../planner/api", () => ({
  createPlannerTask: createPlannerTaskMock,
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
    createPlannerTaskMock.mockResolvedValue({});
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

  it("turns the summary into an actionable next listening pass", async () => {
    const user = userEvent.setup();
    renderReport();
    await reportReady();

    expect(screen.getByRole("heading", { name: /a short working story/i })).toBeInTheDocument();
    expect(screen.getByText(/what are you trying to improve/i)).toBeInTheDocument();
    expect(screen.getByText(/what should you listen for next/i)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(/what are you trying to improve/i),
      "Make the bass more defined",
    );
    await user.type(
      screen.getByLabelText(/what should you listen for next/i),
      "The low end when the drums arrive",
    );
    await user.click(screen.getByRole("button", { name: /add next-pass task/i }));

    await screen.findByText("Added to Studio Planner.");
    expect(createPlannerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Make the bass more defined",
      projectId: "preview-project",
      notes: expect.stringContaining("The low end when the drums arrive"),
    }));
  });

  it("keeps the session summary concise while preserving the full event log", async () => {
    renderReport();
    await reportReady();

    const sessionAtAGlance = screen.getByRole("region", { name: /session at a glance/i });
    expect(within(sessionAtAGlance).getByText(/work changes/i)).toBeInTheDocument();
    expect(within(sessionAtAGlance).getByText(/tracks/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /capture mix/i })).not.toBeInTheDocument();
  });

  it("opens the exact history capture instead of silently adding its sibling sittings", async () => {
    const user = userEvent.setup();
    const selected = reportPreviewSessions.find((session) => session.id === REPORT_PREVIEW_SESSION_ID)!;
    const earlierSitting = {
      ...selected,
      id: "earlier-v08-sitting",
      event_count: 432,
      creative_event_count: 300,
      started_at_ms: selected.started_at_ms - 30 * 60_000,
    };

    render(
      <SessionRecapScreen
        sessionId={selected.id}
        sessions={[...reportPreviewSessions, earlierSitting]}
        onSelectSession={vi.fn()}
        onOpenTimeline={vi.fn()}
        onOpenProjects={vi.fn()}
      />,
    );

    await reportReady();

    expect(screen.getByText("Capture report")).toBeInTheDocument();
    expect(screen.getByText(/19 captured events in this sitting/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Report scope" })).toHaveValue("capture");
    const sessionAtAGlance = screen.getByRole("region", { name: /session at a glance/i });
    expect(within(sessionAtAGlance).getByText(/work changes/i)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /work changes/i }));
    const rawRecord = screen.getByRole("region", { name: /full capture record/i });
    expect(within(rawRecord).getByText(/19 captured events/i)).toBeInTheDocument();
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
    await screen.findByText(/step 5 of 5/i);

    screen.getByRole("tab", { name: /since last time/i }).focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByText(/step 1 of 5/i);
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

describe("report loader", () => {
  it("uses a single centered spinner", () => {
    render(<ReportLoading />);

    expect(screen.getByRole("status", { name: "Building session report" })).toBeInTheDocument();
    expect(document.querySelector(".report-loading__spinner")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".report-loading__copy")).toBeNull();
    expect(document.querySelector(".report-loading__skeleton")).toBeNull();
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

    const bars = screen.getAllByRole("button", { name: /% of the work in this report/i });
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

    const [leader] = screen.getAllByRole("button", { name: /% of the work in this report/i });
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

  it("expands and collapses every change detail from the wide sidebar", async () => {
    const { user, dialog } = await openDrawer();

    await user.click(within(dialog).getByRole("button", { name: "Expand evidence panel" }));
    const expandAll = within(dialog).getByRole("button", { name: "Expand all details" });
    await user.click(expandAll);

    const rows = dialog.querySelectorAll(".report-evidence__toggle");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).toHaveAttribute("aria-expanded", "true");

    await user.click(within(dialog).getByRole("button", { name: "Collapse all details" }));
    for (const row of rows) expect(row).toHaveAttribute("aria-expanded", "false");
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
    await user.click(screen.getByRole("tab", { name: /work changes/i }));

    expect(screen.getByRole("table", { name: /every decision, oldest first/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /mixing/i }));

    expect(screen.queryByRole("table", { name: /every decision/i })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: /mixing decisions, oldest first/i })).toBeInTheDocument();
  });

  it("lets the user inspect the complete event record behind the work summary", async () => {
    const user = userEvent.setup();
    renderReport();
    await reportReady();
    await user.click(screen.getByRole("tab", { name: /work changes/i }));

    const fullRecord = screen.getByRole("region", { name: /full capture record/i });
    const toggle = within(fullRecord).getByRole("button", { name: /view raw events/i });
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(fullRecord).getByText(/unfiltered event log/i)).toBeInTheDocument();
    expect(within(fullRecord).getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});
