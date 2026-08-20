# Ableton tracking inventory

This document separates **what Live exposed during an inspected Set** from
**what Recall currently persists as production capture**. They are related, but
they are not interchangeable:

For a reference focused on the undocumented Live Object Model itself, see
[Ableton Live Object Model reference (observed in Live 12.4.3)](./ableton-lom-reference-live-12.4.3.md).

- **Observed** means the read-only `RecallExplorer` Control Surface successfully
  read the object/property from Live's Object Model (LOM). Explorer does not
  send it to Recall or store it in the app.
- **Captured** means the Recall Control Surface emits it into Recall's event or
  snapshot pipeline. The [capture evidence contract](./capture-evidence.md) is
  authoritative for the claims Recall may make in its UI.

## Verified scan

| Field | Value |
|---|---|
| Live build | Live 12.4.3 |
| Scan date | 2026-08-14 |
| Explorer run | `lom-1786721631227` |
| Unique LOM objects | 699 |
| Safety truncations | none |
| Explorer failures | none |
| Test Set shape | 14 tracks, 8 scenes, 88 clip slots |

The scanner deduplicates objects through Live's `_live_ptr` identity. A Python
wrapper can otherwise make one Track appear as several objects when it is
reached through `tracks`, `visible_tracks`, a ClipSlot, or `canonical_parent`.

## Observed LOM surface in this Set

| Object type | Count | Examples of readable state |
|---|---:|---|
| `Song.Song` | 1 | tempo, transport, loop, time signature, scenes, tracks, return tracks, cue points, scale settings |
| `Track.Track` | 14 | name, colour, group, arm/mute/solo state, input/output routing, clip slots, devices, mixer device |
| `MixerDevice.MixerDevice` | 14 | volume, pan, activator, send controls, master split/crossfader controls |
| `Device.Device` | 2 | name, class name, enabled state, parameters |
| `DeviceParameter.DeviceParameter` | 159 | name, original name, value, minimum, maximum, quantized state, automation state, parent |
| `Scene.Scene` | 8 | name, colour, clip slots |
| `ClipSlot.ClipSlot` | 88 | clip presence, clip reference, launch/record/trigger state, colour |

Live represents child collections as `Base.Vector` and specialised `*Vector`
objects rather than ordinary Python lists. Explorer reads them as bounded
collections; the current limit is 128 entries per collection.

## What Recall captures today

The table is a concise navigation aid; use
[capture-evidence.md](./capture-evidence.md) for the evidence boundary and
[recall-schema-map.md](./recall-schema-map.md) for the app/schema maturity map.

| Area | Observed in LOM | Recall capture posture |
|---|---|---|
| Set context | name/path when Live exposes it, tempo, signature, transport | captured in snapshots and context events where available |
| Track structure | tracks, return tracks, group membership, names, colours | creation, deletion, rename, grouping, and structural snapshots |
| Mixer | volume, pan, sends, activator, master controls | settled volume/pan/send gestures; temporary mute/solo choices are intentionally not timeline moves |
| Devices | device identity, enabled state, parameter collection | structural snapshots; selected-track device changes |
| Device parameters | values, bounds, quantization, automation state | selected-track parameter gestures and automation-write observations |
| Clips and scenes | clip slots, clip state, scenes | launches plus selected-track clip/note-edit observations |
| Routing | available/current input and output routing | observed by Explorer; not currently a Recall routing entity |
| Exact automation geometry | listener state and current transport position | not available live; requires a post-save `.als` index before Recall can claim exact envelope points |

## Observed parameter contract

The `DeviceParameter.DeviceParameter` surface in this run exposed these
readable fields (some item lists are meaningful only for discrete controls):

| Field | Meaning |
|---|---|
| `name` | Display name shown by the device |
| `original_name` | Device-provided parameter name |
| `value` | Current raw numeric value |
| `display_value` | Live-formatted value suitable for display |
| `default_value` | Device's raw default value |
| `min` / `max` | Raw value bounds |
| `is_quantized` | Whether the value moves in discrete states |
| `is_enabled` | Whether Live currently enables the control |
| `automation_state` | Live's current automation/playback/write status |
| `state` | Live's current parameter state value |
| `value_items` / `short_value_items` | Available full/short labels for discrete values, when exposed |
| `canonical_parent` | Parent device or mixer object |

`str_for_value(value)`, `begin_gesture()`, `end_gesture()`, and the listener
registration methods are also exposed as methods. Explorer lists methods but
never calls them. Recall's capture script uses `str_for_value(value)` for its
human-readable before/after parameter labels.

## Device parameter inventory: current test Set

This is **not** a catalogue of every Live device. The inspected Set has two
devices, both on return tracks. Parameter indexes are zero-based LOM positions;
record both the index and name when building automation or mapping features.

### Return A: `Reverb`

LOM base path: `song.return_tracks[0].devices[0]`
Class: `Reverb`
Parameter count: 33

| Index | Parameter | Raw range | Quantized |
|---:|---|---|---|
| 0 | Device On | 0–1 | yes |
| 1 | Predelay | 0–1 | no |
| 2 | In Lo Cut On | 0–1 | yes |
| 3 | In Hi Cut On | 0–1 | yes |
| 4 | Input Freq | 0–1 | no |
| 5 | Input Width | 0–1 | no |
| 6 | ER Spin On | 0–1 | yes |
| 7 | ER Spin Rate | 0–1 | no |
| 8 | ER Spin Amount | 0–1 | no |
| 9 | ER Shape | 0–1 | no |
| 10 | Diff. Hi On | 0–1 | yes |
| 11 | Diff. Hi Type | 0–1 | yes |
| 12 | Diff. Hi Freq | 0–1 | no |
| 13 | HiShelf Gain | 0–1 | no |
| 14 | Diff. Lo On | 0–1 | yes |
| 15 | Diff. Lo Freq | 0–1 | no |
| 16 | LowShelf Gain | 0–1 | no |
| 17 | Chorus On | 0–1 | yes |
| 18 | Chorus Rate | 0–1 | no |
| 19 | Chorus Amount | 0–1 | no |
| 20 | Decay Time | 0–1 | no |
| 21 | Diffusion | 0–1 | no |
| 22 | Scale | 0–1 | no |
| 23 | Freeze On | 0–1 | yes |
| 24 | Flat On | 0–1 | yes |
| 25 | Cut On | 0–1 | yes |
| 26 | Room Size | 0–1 | no |
| 27 | Size Smoothing | 0–2 | yes |
| 28 | Stereo Image | 0–1 | no |
| 29 | Density | 0–3 | yes |
| 30 | Reflect Level | 0–1 | no |
| 31 | Diffuse Level | 0–1 | no |
| 32 | Dry/Wet | 0–1 | no |

### Return B: `Delay`

LOM base path: `song.return_tracks[1].devices[0]`
Class: `Delay`
Parameter count: 27

| Index | Parameter | Raw range | Quantized |
|---:|---|---|---|
| 0 | Device On | 0–1 | yes |
| 1 | Smoothing | 0–2 | yes |
| 2 | Link | 0–1 | yes |
| 3 | Ping Pong | 0–1 | yes |
| 4 | L Sync | 0–1 | yes |
| 5 | R Sync | 0–1 | yes |
| 6 | L Time | 0–1 | no |
| 7 | R Time | 0–1 | no |
| 8 | L 16th | 0–7 | yes |
| 9 | R 16th | 0–7 | yes |
| 10 | L Offset | 0–1 | no |
| 11 | R Offset | 0–1 | no |
| 12 | Feedback | 0–1 | no |
| 13 | Freeze | 0–1 | yes |
| 14 | Filter On | 0–1 | yes |
| 15 | Filter Freq | 0–1 | no |
| 16 | Filter Width | 0–1 | no |
| 17 | LFO Mode | 0–5 | yes |
| 18 | LFO Freq | 0–1 | no |
| 19 | LFO Time | 0–1 | no |
| 20 | LFO Synced | 0–21 | no |
| 21 | LFO 16th | 1–64 | no |
| 22 | LFO Wave | 0–6 | yes |
| 23 | LFO Morph | 0–1 | no |
| 24 | LFO > Delay | 0–1 | no |
| 25 | LFO > Filter | 0–1 | no |
| 26 | Dry/Wet | 0–1 | no |

## Mixer controls

The remaining 99 parameter objects belong to mixer devices. The observed paths
include per-track `volume`, `panning`, `track_activator`, and `sends[index]`,
plus master-only `crossfader`, `left_split_stereo`, and `right_split_stereo`.

These are parameter objects with the same value/range/quantization contract as
device parameters. Recall currently treats settled volume, pan, and send moves
as high-value creative decisions; see the capture evidence contract for the
intentional boundaries around mute and solo.

## Extending this inventory

To add a device or test a suspected undocumented property:

1. Put the device in a dedicated Ableton test Set and save a copy.
2. Run `RecallExplorer` against that Set and wait for `run_completed` with no
   truncations.
3. Record the Live version, device class, LOM base path, parameter indexes,
   names, raw ranges, and quantization in a new versioned section here.
4. Only promote a field from **observed** to **captured** after the Recall
   Control Surface, protocol, storage, and capture-evidence documentation all
   support it.
