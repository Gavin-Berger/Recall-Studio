import { describe, expect, it } from "vitest";
import type { SavedSessionEvent } from "../../../types";
import { captureCoverage, describeCaptureCoverage } from "./captureCoverage";

function focusEvent(payload: unknown, overrides: Partial<SavedSessionEvent> = {}): SavedSessionEvent {
  return {
    id: "focus-1",
    type: "focus_changed",
    timestamp_ms: 1_700_000_000_000,
    summary: null,
    title: "Focus changed",
    description: "Selected track changed",
    source: "control_surface",
    payload: JSON.stringify(payload),
    session_id: "take-1",
    track: "Lead",
    track_type: "midi",
    device: "Serum",
    device_chain: null,
    parameter: null,
    parameter_value: null,
    previous_parameter_value: null,
    parameter_value_percent: null,
    previous_parameter_value_percent: null,
    parameter_display_value: null,
    previous_parameter_display_value: null,
    parameter_is_quantized: null,
    clip_name: null,
    sample_name: null,
    file_path: null,
    bpm: null,
    playing: null,
    is_heartbeat: false,
    ...overrides,
  };
}

describe("capture coverage", () => {
  it("reports full coverage when no device exceeded the listener cap", () => {
    const coverage = captureCoverage([
      focusEvent({ parameter_count: 90, parameter_count_total: 90, parameters_truncated: false, truncated_devices: [] }),
    ]);
    expect(coverage.partial).toBe(false);
    expect(describeCaptureCoverage(coverage)).toBeNull();
  });

  it("names the devices whose controls were outside capture range", () => {
    const coverage = captureCoverage([
      focusEvent({
        parameters_truncated: true,
        truncated_devices: [{ device_name: "Serum 2", watched: 128, available: 1400 }],
      }),
    ]);
    expect(coverage.truncatedDevices).toEqual([
      { deviceName: "Serum 2", watched: 128, available: 1400 },
    ]);
    expect(coverage.unwatchedParameterCount).toBe(1272);
    expect(describeCaptureCoverage(coverage)).toBe(
      "1272 controls on Serum 2 were outside capture range — moves there were not recorded.",
    );
  });

  // A device is re-reported every time its track is selected. The honest claim
  // about the whole capture is the widest gap that ever existed, not the last.
  it("keeps the widest reading per device across repeated focus reports", () => {
    const coverage = captureCoverage([
      focusEvent({ truncated_devices: [{ device_name: "Serum 2", watched: 128, available: 1400 }] }),
      focusEvent({ truncated_devices: [{ device_name: "Serum 2", watched: 128, available: 300 }] }, { id: "focus-2" }),
    ]);
    expect(coverage.truncatedDevices).toHaveLength(1);
    expect(coverage.unwatchedParameterCount).toBe(1272);
  });

  it("ignores reports where nothing was actually truncated", () => {
    const coverage = captureCoverage([
      focusEvent({ truncated_devices: [{ device_name: "Saturator", watched: 128, available: 12 }] }),
    ]);
    expect(coverage.partial).toBe(false);
  });

  it("survives an old payload that carries no coverage fields at all", () => {
    const coverage = captureCoverage([focusEvent({ parameter_count: 40 })]);
    expect(coverage).toMatchObject({ truncatedDevices: [], unwatchedParameterCount: 0, partial: false });
    // The event still proves the bridge was watching, even with no truncation
    // fields — that is what separates "no gaps" from "no idea".
    expect(coverage.observed).toBe(true);
  });

  it("ignores unparseable payloads and non-focus events", () => {
    const coverage = captureCoverage([
      focusEvent({}, { payload: "not json" }),
      focusEvent({ truncated_devices: [{ device_name: "Serum 2", watched: 128, available: 1400 }] }, { type: "heartbeat" }),
    ]);
    expect(coverage.partial).toBe(false);
  });

  it("summarises several partially watched devices without listing all of them", () => {
    const coverage = captureCoverage([
      focusEvent({
        truncated_devices: [
          { device_name: "Serum 2", watched: 128, available: 1400 },
          { device_name: "Massive", watched: 128, available: 500 },
          { device_name: "Reaktor 6", watched: 128, available: 200 },
        ],
      }),
    ]);
    expect(describeCaptureCoverage(coverage)).toBe(
      "1716 controls on Serum 2, Massive and 1 more were outside capture range — moves there were not recorded.",
    );
  });
});
