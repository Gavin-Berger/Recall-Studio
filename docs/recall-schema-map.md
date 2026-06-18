# Recall Schema Map

> **Audience note.** This is the **data-division plan** — the map of every entity and event
> Recall Studio knows how to represent, and how mature each one is. "Schema" here doesn't mean
> a single SQL schema; it means *how we carve up the data the bridge sends* into a structure
> the app can reason about. It's a planning document as much as a reference: a place to see
> what exists, what's half-built, and what's next — at a glance.

This doc sits alongside the two it depends on:

- [`recall-protocol-v2.md`](./recall-protocol-v2.md) — the **wire contract** (exact field names,
  packet format, producer-facing phrasing). When this doc and the protocol doc disagree on a
  field name, the protocol doc wins.
- [`ableton-bridge-architecture.md`](./ableton-bridge-architecture.md) — the **mechanism**
  (how Ableton state reaches the app: poll → diff → UDP → Rust → SQLite).

**Source of truth.** The running system is authoritative, not this doc. The three places that
actually define the schema are:

- Entity tree + projection: [`src-tauri/src/schema_projection.rs`](../src-tauri/src/schema_projection.rs)
- Materialized tables: [`src-tauri/src/storage.rs`](../src-tauri/src/storage.rs)
- Event vocabulary: [`src-tauri/src/event_catalog.rs`](../src-tauri/src/event_catalog.rs)
- What's actually emitted: [`m4l/recall_m4l_bridge.js`](../m4l/recall_m4l_bridge.js) (repo copy at
  bridge **v0.12.0**)

When you wire something new, update the code first and this doc second.

---

## The two layers

The data splits into two fundamentally different shapes. Keep them separate — conflating them
is the mistake the whole architecture is built to avoid.

| Layer | What it is | Shape | Mutability | Lives in |
|---|---|---|---|---|
| **Entities** (nouns) | The *structure* of the set: what tracks/devices/clips exist right now | A tree, rebuilt from the latest deep snapshot | A **rebuildable projection** — deleted + re-derived on demand | `tracks`, `devices`, `parameters`, … |
| **Events** (verbs) | The *changes* a producer made: what they did and when | A flat, time-ordered log | **Immutable** — the system of record | `events` |

The entity tree is a *projection of* the event log. The log is truth; the tree is a convenience
rebuilt from it (`materialize_session_schema`). User-authored creative moments are the one thing
that is **neither** — they're authored on top and never overwritten by re-materialization.

### Status legend

Every row below carries a maturity marker. This is the point of the document.

| Status | Meaning |
|---|---|
| **live** | Emitted by the bridge today **and** materialized into the tree / surfaced to the app. Works end to end. |
| **defined** | Named in the catalog, protocol, or storage schema — or read inside a snapshot — but **not yet flowing**: not auto-emitted, or a column/field that exists but is never populated. |
| **proposed** | Not captured anywhere yet. A forward plan, listed so the day we capture it the shape is already agreed. |

> Why list `defined` and `proposed` rows at all? Because a named-but-empty slot is free, and it
> means the day the bridge starts emitting it, the backend already classifies, titles, stores,
> and renders it with zero new plumbing. The catalog is intentionally ahead of the bridge.

---

## Layer 1 — Entity schema (the structural tree)

### The tree at a glance

Markers: `●` live · `◐` defined (partial / not populated) · `○` proposed.

```
● Project · Live Set
  │   name, file_path, tempo, time signature, transport flags
  │   ◐ master volume   ○ key/scale   ○ arrangement length
  │
  ├─ ● Track ─ type ∈ { ● audio  ● midi  ● return  ● group  ◐ master }
  │     │   name, number, color, group parent, mute/solo/arm
  │     │   ○ input_routing   ○ output_routing   ○ is_frozen
  │     │
  │     ├─ ○ Mixer strip        volume · pan · sends[] · activator · xfade assign
  │     │
  │     ├─ ● Device ─ role ∈ { ● instrument  ● midi_effect  ● audio_effect }
  │     │     │   name, class_name, chain_index, enabled
  │     │     │   ◐ vendor   ◐ plugin_format   ◐ preset_name
  │     │     │   ○ Rack → Chain → nested Device (drum/instrument racks)
  │     │     │
  │     │     └─ ● Parameter      value · min · max · normalized_value
  │     │           ◐ unit   ◐ automation_state   ○ children[] macros (live for racks)
  │     │
  │     └─ ◐ Clip ─ kind ∈ { ◐ audio  ◐ midi }
  │           name, color, slot, length, loop, file_path/sample_name
  │           ○ warp_mode · gain · pitch (audio)   ○ notes (midi)
  │
  ├─ ◐ Scene            index · name · color   ○ tempo/sig override
  └─ ○ Routing · Sends  input/output graph + (track × return) send matrix
```

### Project · Live Set — **live** (root)

The root node, one per `.als`. Rebuilt from the latest deep `live_set_snapshot`.

| Field | Status | Notes |
|---|---|---|
| `name`, `file_path` | live | from `live_set`; `project_name` also used to group captures |
| `tempo` (bpm) | live | |
| `signature_numerator` / `_denominator` | live | |
| `current_song_time` | live | bar/beat context for automation |
| `track_count` / `return_track_count` / `scene_count` | live | |
| `metronome` / `session_record` / `arrangement_overdub` | live | transport flags |
| `master_volume` | defined | master track is scanned for devices, but its mixer/volume isn't stored |
| `key` / `scale` | proposed | no Live API surface — would require parsing the `.als` XML |
| `locators[]` (arrangement markers) | proposed | `locator_added` event is in the catalog but unwired |
| `arrangement_length` | proposed | |

### Track — **live** (4 of 5 types)

The spine of the schema, and the part that already works well. Each track is **typed** so the
timeline can say *what kind of thing* the producer was working on, not just its name.
Stored in `tracks`; parsed in `parse_session_tree` / `derive_track_type`.

| Subtype | Status | How it's derived |
|---|---|---|
| `audio` | live | `has_midi_input == false` |
| `midi` | live | `has_midi_input == true` (or an instrument in the chain) |
| `return` | live | lives in Live's separate `return_tracks` collection |
| `group` | live | `is_foldable == true` |
| `master` | **defined** | bridge scans `master_track` for device changes, but there is **no `TrackType::Master`** for it to land on |

| Field | Status | Notes |
|---|---|---|
| `id`, `name`, `number`, `color` | live | `number` is the 1-based index |
| `type` | live | the enum above |
| `group_id` (parent nesting) | live | rebuilds Group → Track nesting from `group_track_id` |
| `mute` / `solo` / `arm` / `can_be_armed` | live | diffed every transport tick for lifecycle events |
| `has_midi_input` / `is_foldable` / `fold_state` | live | typing signals |
| **master as a typed node** | defined | the one-line extension: add `Master` to the enum |
| `input_routing` / `output_routing` | proposed | see Routing entity below |
| `is_frozen` / `monitoring_state` | proposed | `track_frozen` event exists but unwired |

### Mixer strip — **proposed entity** (per track)

Volume, pan, and sends exist today only as **fleeting events** (and even those are unwired —
see the Mixing domain). There is no per-track entity holding *current* mixer state, so the app
can't show "where the faders sit." Modeling it gives every track a stable mix face.

> Storage is already half-ready: `creative_moments.type` includes `mix_move`, so a mixer change
> can be pinned as a moment even before a mixer table exists.

| Field | Status | Notes |
|---|---|---|
| `volume` | defined | `volume_changed` named in catalog, not emitted |
| `pan` | defined | `pan_changed` named in catalog, not emitted |
| `sends[]` → per return | defined | `send_changed` named in catalog, not emitted |
| `track_activator` (on/off) | proposed | |
| `crossfade_assign` (A / B / none) | proposed | |

### Device — **live** (3 roles)

Sits inside a track in chain order. Role is read from the Live API (`Device.type`) so the MIDI
signal chain — `midi_effect → instrument → audio_effect` — is recoverable downstream.
Stored in `devices`; classified in `device_role` (bridge) / `derive_device_role` (Rust).

| Subtype (role) | Status |
|---|---|
| `instrument` | live |
| `midi_effect` | live |
| `audio_effect` | live |

| Field | Status | Notes |
|---|---|---|
| `id`, `name`, `class_name` | live | `name` = what the producer sees (incl. plugin display names) |
| `role`, `type` (int), `chain_index` | live | |
| `enabled` (`is_active`) | live | defaults ON when absent |
| `vendor` | defined | **column exists** in `devices`, never populated |
| `plugin_format` (native/vst/vst3/au/aax) | defined | **column exists**, never populated — would flag plugin vs native |
| `preset_name` | defined | **column exists**, never populated |
| **Rack → Chain → nested Device** | proposed | drum racks / instrument racks — the one structural shape the flat list can't represent. `device.can_have_chains` is the entry point |

### Parameter — **live** (with nesting)

A single knob/slider on a device. Already supports `children[]` for rack macros and chained
parameters. Stored in `parameters` (self-referential via `parent_parameter_id`).

| Field | Status | Notes |
|---|---|---|
| `id`, `name`, `value` | live | |
| `min`, `max`, `normalized_value` | live | |
| `children[]` (macros / chained params) | live | self-referential nesting |
| `unit` | defined | **column + projection field exist**, but `build_parameter_changes` always sets `None` |
| `automation_state` | defined | read to detect `automation_created`, not stored as parameter state |
| `is_enabled` | defined | read in the deep scan, not persisted |
| `default_value` / `value_items` (enum params) | proposed | e.g. filter-type dropdowns |

> **The biggest single gap in this layer** is not a field — it's the *change* feed. Real-time
> `parameter_changed` from live knob moves is **defined but not auto-emitted** (manual Max
> message only). Wiring it — with the debounce specified in the protocol doc — is what fills the
> parameter-change timeline during an actual session. See the gap list.

### Clip — **defined** (captured, not materialized)

The primary unit of work in Ableton. Captured today **as events** (`clip_created`,
`sample_added`, `midi_clip_created`) and **inside the deep snapshot** (`clip_slots`), but never
promoted to a node in the tree the way devices are — there is no `clips` table.

> Storage anticipates it: `creative_moment_targets.target_type` already accepts `clip`, so a
> clip can be a moment target before the entity exists.

| Subtype | Status |
|---|---|
| audio clip | defined |
| midi clip | defined |

| Field | Status | Notes |
|---|---|---|
| `id`, `name`, `color`, `slot_index` | defined | read in `collect_focus_clips_for_track` / deep snapshot |
| `length`, `loop_start`, `loop_end`, `looping` | defined | in the deep snapshot only |
| audio: `file_path`, `sample_name` | defined | the real sample backing the clip (e.g. a Splice drag-in) |
| audio: `warp_mode`, `gain`, `pitch` | proposed | |
| midi: `note_count`, `notes` | proposed | MIDI note editing isn't captured at all today |
| arrangement `start_time` vs session `slot` | proposed | Session-view slots only today; Arrangement clips aren't diffed |

### Scene — **defined** (summaries only)

A row of clips launched together (Session View). Captured as **summaries** in the live-set
snapshot (`collect_scene_summaries`), but not materialized as entities or hung on the timeline.

| Field | Status | Notes |
|---|---|---|
| `index`, `name`, `color` | defined | in the snapshot summary |
| `tempo` override / `time_signature` override | proposed | |
| `is_triggered` | proposed | |
| clips launched in this scene | proposed | |

### Routing · Sends — **proposed entity**

The signal-flow graph: where each track's audio/MIDI comes *from* and goes *to*, plus the
`track × return` send matrix. Today only a single unwired event name (`track_routing_changed`)
exists. Depends on the return tracks already modeled — the missing piece is the **edges**
between nodes.

> Storage anticipates it too: `creative_moments.type` includes `routing`.

| Field | Status | Notes |
|---|---|---|
| `input_type` / `input_channel` (from) | proposed | |
| `output_type` / `output_channel` (to) | proposed | |
| send matrix: `track × return → level` | defined | `send_changed` named, unwired |
| `track_routing_changed` event | defined | in catalog, not emitted |

---

## Layer 2 — Event vocabulary (the change stream)

Every kind of change the bridge can report, grouped by domain. Mirrors
[`event_catalog.rs`](../src-tauri/src/event_catalog.rs) (priority + fallback copy) and the
producer-facing phrasing in [`recall-protocol-v2.md`](./recall-protocol-v2.md). The **Status**
column is this doc's addition: is it actually flowing?

Counts below: **live** = auto-emitted by the bridge today. Manual-only entry points (fired by a
Max message, not automatic capture) are marked **defined · manual**.

### Bridge lifecycle — 4/4 live

| `event_type` | Status |
|---|---|
| `heartbeat` | live |
| `device_loaded` | live |
| `bridge_started` | live |
| `bridge_stopped` | live |

### Transport & tempo — 4/10 live

| `event_type` | Status |
|---|---|
| `transport_play` | live |
| `transport_stop` | live |
| `transport_snapshot` | live |
| `tempo_changed` | live |
| `beat_time_changed` | defined · manual |
| `transport_changed` | defined |
| `playback_state_changed` | defined |
| `metronome_toggled` | defined |
| `loop_toggled` | defined |
| `recording_state_changed` | defined |

### Track lifecycle — 13/13 live (selection + structural)

| `event_type` | Status |
|---|---|
| `track_selected` | live |
| `selected_track_focus_snapshot` | live |
| `track_created` | live |
| `track_deleted` | live |
| `track_name_changed` | live |
| `track_muted` / `track_unmuted` | live |
| `track_soloed` / `track_unsoloed` | live |
| `track_armed` / `track_unarmed` | live |
| `track_duplicated` | defined |
| `track_frozen` | defined |
| `track_flattened` | defined |
| `track_color_changed` | defined |

### Groups & routing — 0/5 live (entire domain unwired)

| `event_type` | Status |
|---|---|
| `group_focused` | defined |
| `tracks_grouped` | defined |
| `track_ungrouped` | defined |
| `return_track_added` | defined |
| `track_routing_changed` | defined |

### Devices — 3/8 live

| `event_type` | Status |
|---|---|
| `device_added` | live |
| `device_removed` | live |
| `device_chain_changed` | live |
| `device_selected` | defined · manual |
| `device_toggled` | defined |
| `device_preset_changed` | defined |
| `macro_mapped` | defined |
| `device_event` | defined |

### Parameters & automation — 1/5 live

| `event_type` | Status |
|---|---|
| `automation_created` | live |
| `parameter_changed` | defined · manual — **the big gap** (live knob moves) |
| `device_parameter_changed` | defined |
| `automation_edited` | defined |
| `automation_deleted` | defined |

### Clips & samples — 5/15 live

| `event_type` | Status |
|---|---|
| `sample_added` | live |
| `audio_clip_added` | live |
| `midi_clip_created` | live |
| `clip_created` | live |
| `clip_deleted` | live |
| `clip_launched` | defined · manual |
| `clip_stopped` | defined |
| `clip_renamed` | defined |
| `clip_moved` | defined |
| `clip_duplicated` | defined |
| `clip_recording_started` / `_stopped` | defined |
| `warp_mode_changed` | defined |
| `clip_consolidated` | defined |
| `clip_event` | defined |

### Scenes & performance — 0/5 live (entire domain unwired)

| `event_type` | Status |
|---|---|
| `scene_launched` | defined |
| `scene_changed` | defined |
| `scene_created` | defined |
| `scene_renamed` | defined |
| `follow_action_fired` | defined |

### Mixing — 0/4 live (entire domain unwired)

| `event_type` | Status |
|---|---|
| `volume_changed` | defined |
| `pan_changed` | defined |
| `send_changed` | defined |
| `crossfader_changed` | defined |

### Recording — 0/3 live

| `event_type` | Status |
|---|---|
| `recording_started` | defined |
| `recording_stopped` | defined |
| `take_comped` | defined |

### Session · project · arrangement — 4/10 live

| `event_type` | Status |
|---|---|
| `project_context` | live |
| `live_set_snapshot` | live (manual deep capture) |
| `session_snapshot_started` / `_completed` | live |
| `session_snapshot` | defined |
| `project_saved` | defined |
| `project_file_changed` | defined |
| `locator_added` | defined |
| `arrangement_section_changed` | defined |
| `creative_decision` | defined |

### Debug — 1/1 live

| `event_type` | Status |
|---|---|
| `raw_max_message` | live |

---

## Where entities land in storage

The materialized projection tables in [`storage.rs`](../src-tauri/src/storage.rs). All are
`DELETE`d + re-`INSERT`ed per session by `materialize_session_schema` — they can always be
rebuilt from the `events` log without data loss. The creative-memory tables are the exception:
**user-authored, never touched by materialization.**

| Table | Holds | Re-materialized? |
|---|---|---|
| `events` | the immutable log (system of record) | no — it *is* the source |
| `tracks` | Track entities | yes |
| `devices` | Device entities (has unused `vendor` / `plugin_format` / `preset_name`) | yes |
| `parameters` | Parameter entities (self-referential nesting; unused `unit`) | yes |
| `parameter_changes` | derived before→after change rows | yes |
| `creative_moments` | **user-authored** pins (`type`, `confidence`) | **no** |
| `creative_moment_targets` | what a moment points at (`target_type` already allows `clip`) | **no** |

Tables that **don't exist yet** and would be the home for the proposed entities: `clips`,
`scenes`, `mixer_strips` (or columns on `tracks`), `routings` / `sends`.

---

## The gap list — what to wire next

Priority-ordered. The first three are the highest value-per-effort because the data is already
being read — they're modeling/wiring work, not new capture.

1. **`Master` track type** *(smallest win)* — add `TrackType::Master`; the bridge already scans
   `master_track`. Lets master-bus devices (mixdown/mastering chain) land as a typed node.
2. **Clips as a first-class entity** *(highest value)* — add a `clips` table + tree nodes from
   the deep snapshot's `clip_slots` (sample, length, loop, warp). The data already exists; it
   needs a home. Then wire `clip_launched/moved/renamed` on top.
3. **Real-time `parameter_changed`** *(pays off twice)* — emit live knob moves from the bridge
   with the required debounce (protocol doc §"Parameter rate-limiting"). Same task as bridge
   gesture-coalescing on the beta roadmap. Fills the parameter timeline during a real session.
4. **Mixer strip entity + Mixing events** — model volume/pan/sends as current state and emit the
   four mixing events (debounced). Captures the whole "balancing the mix" phase, which is
   invisible today.
5. **Device metadata populate** — fill the existing `vendor` / `plugin_format` / `preset_name`
   columns from the bridge. No schema change — the columns are already there.
6. **Rack → Chain nesting** — represent drum/instrument racks as nested device chains.
7. **Routing & send matrix** — the signal-flow graph; mix-engineer feature. Depends on (4).
8. **Scenes as entities** — performance/Session-view producers; lower priority than the above.

---

## How to extend this schema

The established pattern (don't deviate without reason):

1. **Bridge** ([`recall_m4l_bridge.js`](../m4l/recall_m4l_bridge.js)) — read the new field/entity
   in a *bounded, diffed* scan and `emit()` it. Respect the crash rules: no per-frame events,
   no reading every parameter on every track, stay under `MAX_EVENT_BYTES`. Bump `BRIDGE_VERSION`
   and redeploy the M4L copy (it lives outside the repo — see the deploy notes).
2. **Protocol** ([`recall-protocol-v2.md`](./recall-protocol-v2.md)) — register the `event_type`
   and any new canonical field. One name, used everywhere.
3. **Catalog** ([`event_catalog.rs`](../src-tauri/src/event_catalog.rs)) — add the row: priority +
   fallback title/description. (Often already there — much of the vocabulary is pre-declared.)
4. **Projection** ([`schema_projection.rs`](../src-tauri/src/schema_projection.rs)) — if it's an
   *entity*, parse it into the tree as a **pure, unit-tested** function. If it's a *change*,
   extend the derivation.
5. **Storage** ([`storage.rs`](../src-tauri/src/storage.rs)) — add the table/column and include it
   in `materialize_session_schema`'s delete + re-insert. Never let materialization touch the
   creative-memory tables.
6. **Frontend** — surface it in the timeline / schema panels.
7. **This doc** — flip the row from `proposed` → `defined` → `live` as each stage lands.

**Keeping this doc honest:** a row is only `live` when it's flowing end to end. If you add a
column but don't populate it, it's `defined`, not `live`. If the bridge emits it but nothing
renders it, it's still `defined`. The whole value of this map is that the status column doesn't
lie.
