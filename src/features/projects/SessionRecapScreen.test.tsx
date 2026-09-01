// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportLoading, SessionRecapScreen } from "./SessionRecapScreen";
import { reportPreviewSessions, REPORT_PREVIEW_SESSION_ID } from "./sessionReportPreview";

function renderReport(openScope: "sitting" | "version" | "project" = "sitting") {
  const onOpenTimeline = vi.fn();
  render(
    <SessionRecapScreen
      sessionId={REPORT_PREVIEW_SESSION_ID}
      sessions={reportPreviewSessions}
      openScope={openScope}
      onSelectSession={vi.fn()}
      onOpenTimeline={onOpenTimeline}
      onOpenProjects={vi.fn()}
    />,
  );
  return { onOpenTimeline };
}

async function reportReady() {
  return screen.findByRole("tab", { name: /the session/i });
}

describe("report walkthrough", () => {
  it("restores the complete five-step reading flow", async () => {
    renderReport();
    await reportReady();

    expect(screen.getByRole("tablist", { name: /session report views/i })).toBeInTheDocument();
    expect(screen.getByText(/step 1 of 5/i)).toBeInTheDocument();
    expect(screen.getByText(/what happened in this version/i)).toBeInTheDocument();
  });

  it("opens a version report as the full walkthrough", async () => {
    renderReport("version");
    await reportReady();

    expect(screen.getByText("Every sitting")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: /session report views/i })).toBeInTheDocument();
  });

  it("keeps Open Timeline on the Report header", async () => {
    const user = userEvent.setup();
    const { onOpenTimeline } = renderReport();
    await reportReady();

    await user.click(screen.getByRole("button", { name: "Open Timeline" }));
    expect(onOpenTimeline).toHaveBeenCalledWith(REPORT_PREVIEW_SESSION_ID);
  });

  it("moves through the restored walkthrough with the keyboard", async () => {
    const user = userEvent.setup();
    renderReport();
    const first = await reportReady();
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /how it went/i })).toHaveAttribute("aria-selected", "true");
  });
});

describe("report loader", () => {
  it("uses a single centered spinner", () => {
    render(<ReportLoading />);
    expect(screen.getByRole("status", { name: "Building session report" })).toBeInTheDocument();
    expect(document.querySelector(".report-loading__spinner")).toHaveAttribute("aria-hidden", "true");
  });
});
