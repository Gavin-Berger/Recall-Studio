import { describe, expect, it } from "vitest";
import type { SavedSessionEvent } from "../../../types/recall";
import { producerMemoryEvent, producerMemoryEvents } from "./eventMemory";

function savedEvent(over: Partial<SavedSessionEvent>): SavedSessionEvent {
  return {
    id: "1",
    type: "tempo_changed",
    timestamp_ms: 1_000,
    summary: null,
    title: "Event",
    description: "Event",
    source: "control_surface",
    payload: null,
    session_id: "session-1",
    track: null,
    track_type: null,
    device: null,
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
    ...over,
  };
}

describe("producerMemoryEvent", () => {
  it("turns existing tempo events into song memory with arrangement context", () => {
    const memory = producerMemoryEvent(savedEvent({
      bpm: 128,
      payload: JSON.stringify({
        previous_bpm: 124,
        observed_arrangement_position: "Bar 41 · Beat 1",
        observed_arrangement_beats: 160,
      }),
    }));

    expect(memory).toMatchObject({
      category: "song",
      title: "Tempo changed",
      summary: "124 BPM → 128 BPM",
      observedArrangementPosition: "Bar 41 · Beat 1",
      observedArrangementBeats: 160,
    });
  });

  it("explains precise structure and performance events in producer language", () => {
    const events = producerMemoryEvents([
      savedEvent({
        id: "track",
        type: "track_name_changed",
        track: "Lead Hook",
        payload: JSON.stringify({ track_id: "44", previous_track_name: "Serum 2" }),
      }),
      savedEvent({
        id: "scene",
        type: "scene_launched",
        payload: JSON.stringify({ scene_index: 3, scene_name: "Drop" }),
      }),
      savedEvent({
        id: "toggle",
        type: "device_toggled",
        track: "Bass",
        device: "Saturator",
        payload: JSON.stringify({ is_active: false }),
      }),
    ]);

    expect(events.map((event) => event.summary)).toEqual([
      "Serum 2 → Lead Hook",
      "Played Drop",
      "Saturator on Bass",
    ]);
    expect(events[2].title).toBe("Device bypassed");
  });

  it("silently follows Live's automatic numbered-track adjustments", () => {
    const automatic = producerMemoryEvent(savedEvent({
      type: "track_name_changed",
      track: "11-Serum 2",
      payload: JSON.stringify({ previous_track_name: "10-Serum 2" }),
    }));
    const intentional = producerMemoryEvent(savedEvent({
      type: "track_name_changed",
      track: "11-Bass Hook",
      payload: JSON.stringify({ previous_track_name: "10-Serum 2" }),
    }));

    expect(automatic).toBeNull();
    expect(intentional).toMatchObject({
      title: "Track renamed",
      summary: "10-Serum 2 → 11-Bass Hook",
    });
  });

  it("hides duplicated projections, navigation, transport, mute/solo, and arm noise", () => {
    const hidden = [
      "parameter_changed",
      "clip_notes_changed",
      "transport_play",
      "focus_changed",
      "track_muted",
      "track_soloed",
      "track_armed",
      "heartbeat",
    ];

    expect(hidden.map((type) => producerMemoryEvent(savedEvent({ type })))).toEqual(
      hidden.map(() => null),
    );
  });

  it("keeps unknown API telemetry invisible until it earns producer meaning", () => {
    expect(producerMemoryEvent(savedEvent({ type: "output_meter_level_changed" }))).toBeNull();
    expect(producerMemoryEvent(savedEvent({ type: "can_undo_changed" }))).toBeNull();
  });

  it("supports named song sections and summarized mix energy without exposing raw meters", () => {
    const cue = producerMemoryEvent(savedEvent({
      type: "cue_point_added",
      payload: JSON.stringify({ cue_name: "Drop", cue_time: 65 }),
    }));
    const energy = producerMemoryEvent(savedEvent({
      type: "mix_energy_summary",
      track: "Main",
      payload: JSON.stringify({ average_db: -15.2, peak_db: -1.1 }),
    }));

    expect(cue).toMatchObject({
      title: "Song section added: Drop",
      summary: "Marked at beat 65",
      category: "structure",
    });
    expect(energy).toMatchObject({ title: "Mix energy", summary: "-15.2 dB average · -1.1 dB peak", category: "mix" });
    expect(producerMemoryEvent(savedEvent({ type: "output_meter_level_changed" }))).toBeNull();
  });

  it("explains where a song section moved instead of repeating only its name", () => {
    const moved = producerMemoryEvent(savedEvent({
      type: "cue_point_moved",
      payload: JSON.stringify({
        cue_name: "Drop",
        previous_cue_time: 64,
        cue_time: 68,
      }),
    }));

    expect(moved).toMatchObject({
      title: "Song section moved: Drop",
      summary: "beat 64 → beat 68",
      category: "structure",
    });
  });

  it("renders numeric Live keys and exact warp evidence in producer language", () => {
    const scale = producerMemoryEvent(savedEvent({
      type: "scale_changed",
      payload: JSON.stringify({ root_note: 1, scale_name: "Minor" }),
    }));
    const warp = producerMemoryEvent(savedEvent({
      type: "warp_markers_changed",
      clip_name: "Vocal chop",
      payload: JSON.stringify({
        clip_name: "Vocal chop",
        warp_markers: [
          { beat_time: 0, sample_time: 0 },
          { beat_time: 4, sample_time: 1.9 },
        ],
      }),
    }));

    expect(scale).toMatchObject({ title: "Key and scale changed", summary: "C# Minor" });
    expect(warp).toMatchObject({ title: "Timing warped", summary: "Vocal chop: 2 warp markers" });
  });
});

describe("version saves", () => {
  it("names the saved set from its file path when no set name was reported", () => {
    // The bridge often sends only a path. Falling through to the generic "Live
    // Set" made the one row that says which version you can go back to say
    // nothing at all.
    const [saved] = producerMemoryEvents([
      savedEvent({
        id: "saved-1",
        type: "project_saved",
        payload: JSON.stringify({ file_path: "C:/Music/Nightdrive/Nightdrive_v08.als" }),
      }),
    ]);

    expect(saved).toMatchObject({ title: "Version saved", summary: "Nightdrive_v08" });
  });

  it("prefers a reported set name over the path", () => {
    const [saved] = producerMemoryEvents([
      savedEvent({
        id: "saved-2",
        type: "project_saved",
        payload: JSON.stringify({ set_name: "Nightdrive final", file_path: "C:/Music/other.als" }),
      }),
    ]);

    expect(saved?.summary).toBe("Nightdrive final");
  });
});
