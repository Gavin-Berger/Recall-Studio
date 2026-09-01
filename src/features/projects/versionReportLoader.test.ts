import { describe, expect, it } from "vitest";
import {
  BASELINE_PREVIEW_SESSION_ID,
  REPORT_PREVIEW_SESSION_ID,
} from "./sessionReportPreview";
import { loadVersionDepth } from "./versionReportLoader";

describe("Timeline development preview", () => {
  it("loads the same typed capture data as the report preview", async () => {
    const depth = await loadVersionDepth(
      [REPORT_PREVIEW_SESSION_ID],
      { name: "Nightdrive_v07", sessionId: BASELINE_PREVIEW_SESSION_ID },
    );

    expect(depth.report.decisions.length).toBeGreaterThan(0);
    expect(depth.parentName).toBe("Nightdrive_v07");
    expect(depth.diff.status).toBe("changed");
    expect(depth.report.decisions.some((decision) => decision.facts.of === "midi")).toBe(true);
  });
});
