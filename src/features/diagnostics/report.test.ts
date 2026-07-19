import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLoggedErrors,
  describeCause,
  getLoggedErrors,
  recordError,
} from "./errorLog";
import { buildDiagnosticReport, reportFileName, type ReportInput } from "./report";

const NOW = Date.UTC(2026, 6, 18, 15, 4, 5);

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    generatedAtMs: NOW,
    appVersion: "0.1.0",
    platform: "Windows",
    connection: { connected: true, bridgeVersion: "0.20.0", lastHeartbeatMs: NOW - 2000 },
    metrics: null,
    errors: [],
    ...overrides,
  };
}

describe("errorLog", () => {
  beforeEach(() => clearLoggedErrors());

  it("records a problem with its scope, message, and cause", () => {
    recordError("Organizer", "Couldn't read mix.wav", new Error("decode failed"));
    const [entry] = getLoggedErrors();
    expect(entry.scope).toBe("Organizer");
    expect(entry.message).toBe("Couldn't read mix.wav");
    expect(entry.detail).toContain("decode failed");
  });

  it("keeps problems in the order they happened", () => {
    recordError("A", "first");
    recordError("B", "second");
    expect(getLoggedErrors().map((e) => e.message)).toEqual(["first", "second"]);
  });

  it("caps the log so a long session can't grow without bound", () => {
    for (let i = 0; i < 60; i++) recordError("Organizer", `problem ${i}`);
    const logged = getLoggedErrors();
    expect(logged).toHaveLength(50);
    // Oldest trimmed, newest kept.
    expect(logged[logged.length - 1].message).toBe("problem 59");
  });

  it("describes causes of every shape without throwing", () => {
    expect(describeCause(undefined)).toBeUndefined();
    expect(describeCause("plain string")).toBe("plain string");
    expect(describeCause(new Error("boom"))).toContain("boom");
    expect(describeCause({ code: 42 })).toBe('{"code":42}');
  });
});

describe("buildDiagnosticReport", () => {
  it("says so plainly when nothing went wrong", () => {
    const report = buildDiagnosticReport(input());
    expect(report).toContain("PROBLEMS RECORDED (0)");
    expect(report).toContain("(none recorded this session)");
    expect(report).toContain("(the producer did not add a description)");
  });

  it("includes the producer's own description", () => {
    const report = buildDiagnosticReport(input({ note: "  clicked Add version  " }));
    expect(report).toContain("clicked Add version");
    expect(report).not.toContain("did not add a description");
  });

  it("reports connection and bridge version", () => {
    const report = buildDiagnosticReport(input());
    expect(report).toContain("Connected: yes");
    expect(report).toContain("Bridge version: 0.20.0");
    expect(report).toContain("Last heartbeat: 2s ago");
  });

  it("notes when metrics could not be read", () => {
    expect(buildDiagnosticReport(input())).toContain("metrics unavailable");
  });

  it("includes the capture counters that reveal loss", () => {
    const report = buildDiagnosticReport(
      input({
        metrics: {
          packets_received: 1000,
          malformed_packets: 2,
          dropped_packets: 5,
          events_queued: 900,
          events_persisted: 890,
          events_emitted: 890,
          queue_depth: 3,
          last_event_ms: NOW - 60000,
          last_error: "disk full",
          protected_dropped: 1,
          sequence_gaps: 7,
          session_discarded: 0,
          panics_recovered: 1,
          oversized_packets: 4,
        },
      }),
    );
    expect(report).toContain("Sequence gaps: 7");
    expect(report).toContain("Oversized packets: 4");
    expect(report).toContain("Panics recovered: 1");
    expect(report).toContain("Last backend error: disk full");
    expect(report).toContain("Last event: 1m ago");
  });

  it("lists each problem with its cause indented", () => {
    const report = buildDiagnosticReport(
      input({
        errors: [
          {
            id: "e1",
            at_ms: NOW,
            scope: "Organizer",
            message: "Couldn't read mix.wav",
            detail: "Error: decode failed\n  at decodeAudioData",
          },
        ],
      }),
    );
    expect(report).toContain("PROBLEMS RECORDED (1)");
    expect(report).toContain("Organizer: Couldn't read mix.wav");
    expect(report).toContain("    Error: decode failed");
    expect(report).toContain("      at decodeAudioData");
  });
});

describe("reportFileName", () => {
  it("has no characters that break a filesystem", () => {
    const name = reportFileName(NOW);
    expect(name.startsWith("recall-studio-report-")).toBe(true);
    expect(name.endsWith(".txt")).toBe(true);
    expect(name).not.toMatch(/[:*?"<>|]/);
  });
});
