# Capture evidence contract

This is the current source of truth for what Recall can claim about an Ableton
session. It is intentionally narrower than the event catalogue: an event name
does not give the app permission to infer detail that Ableton did not expose.

## Evidence levels

| Level | Meaning | Language allowed in producer UI |
|---|---|---|
| `live_observation` | A Control Surface listener directly reported a value, state change, or the current transport position. | “Changed”, “recorded”, “observed at”, “while playhead moved”. |
| `saved_set_index` | A versioned parser read the saved `.als` document and resolved the relevant object and its Arrangement data. | Exact bar/beat spans, held values, breakpoints, and curves. |
| `derived_summary` | Recall grouped real events to make a short reading aid. | Hedged language only: “looks like”, “likely”, “across two sittings”. |

Raw events remain immutable. A projection may add a source label or grouping, but
it must retain the evidence level that supports the claim.

## Automation: current truth

The Control Surface can observe a producer writing automation through
`DeviceParameter.automation_state`, value listeners, and Live's current song
position. It emits `automation_created` or `automation_edited` with:

- track, device, parameter, and before/after Live-formatted values;
- the first and last **transport positions observed during the input action**;
- the event timestamp and automation state.

Those positions answer *where Recall observed the write*, not where the finished
envelope begins, ends, holds a value, or contains multiple points. The producer
can draw a shape after a listener fires, edit several points in one gesture, or
write a flat section; the Live Object Model does not expose those breakpoint data
to this control surface. Therefore the live timeline must say either:

- `Observed at Bar 61 · Beat 1`, or
- `Observed while playhead moved Bar 61 · Beat 1 → Bar 64 · Beat 1`.

It must not display that interval as the automation lane itself.

## Exact Arrangement automation: next collector

The exact collector is a post-save `.als` index, run against a saved version of
the set. It must emit `saved_set_index` evidence only after these checks pass:

1. A real `.als` fixture from the target Live version proves the compressed XML
   structure and parameter-to-envelope identity mapping.
2. Every extracted breakpoint retains its source parameter identity, musical
   time, and value; unmapped or ambiguous data is omitted rather than guessed.
3. A segment is called a constant only when consecutive saved breakpoints prove
   the same value across its full interval.
4. The UI visibly distinguishes saved-envelope geometry from a live write
   observation, and links both to the same track/device/parameter when possible.

Until that index exists, Recall records the decision to write automation and its
live context faithfully; it does not reconstruct the lane.

## Current high-value coverage and boundaries

- Global mixer volume, pan, and send gestures are captured as settled changes.
  Mute and solo are intentionally not timeline moves: they are often temporary
  monitoring choices, not durable mix decisions.
- Track arm is observed, but appears as a creative record only when a new MIDI
  or audio clip proves that recording happened.
- Device parameter and clip-detail listeners remain selected-track scoped. This
  is a stability boundary, not a claim of project-wide plugin coverage.
- Track creation, deletion, rename, and grouping; scene launches; and selected
  track clip launches are captured as discrete facts.
- `project_path` rides heartbeats so the app can attribute work to the open
  saved set. It does not replace the load-bearing four-hour idle rotation for
  unsaved `Untitled` sets.

`docs/recall-protocol-v2.md` is retained as a wire-format reference but contains
historical coverage notes. Update it alongside this document when the wire
contract changes.
