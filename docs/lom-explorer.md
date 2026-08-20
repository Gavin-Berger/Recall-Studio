# RecallExplorer: read-only LOM discovery

`RecallExplorer` is a separate Ableton Control Surface for mapping the Live
Object Model (LOM). It neither opens a network connection nor imports or emits
Recall's event protocol. Each scan writes a dedicated, raw newline-delimited
JSON file; Live's `Log.txt` only mirrors it for diagnostics.

## Run a scan

1. With Ableton closed, run `npm run deploy:lom-explorer`. On another computer,
   set `RECALL_USER_LIBRARY` to that machine's Ableton User Library first.
2. Start Ableton and open the Set to inspect.
3. In **Preferences -> Link, Tempo & MIDI**, select **RecallExplorer** in an
   unused **Control Surface** slot. It can coexist with Recall, but should only
   be enabled while researching the API.
4. Wait for the record whose `record` is `run_completed`, then deselect the
   surface. The `run_started` record reports the exact output path. On Windows,
   it is normally `%APPDATA%\com.gberg.recall-studio\lom-explorer\scan-<run-id>.jsonl`.
   Each new scan receives a separate file, so old results remain intact.

Each line in that JSONL file is one JSON object. All records sharing a `run_id`
belong to the same scan:

- `run_started` reports the active safety limits.
- `node` contains one LOM object. Its `attributes` show readable properties,
  method names (never called), collection contents, and getter errors.
- `run_completed` reports the object count and any limits reached.
- `run_failed` records an unexpected error; it does not propagate into Live.

The output is a graph: a property with `kind: "object"` first introduces a
node, while `kind: "reference"` points to a node already emitted. This prevents
cycles such as `canonical_parent` from recursing forever.

## Safety limits

The source constants at the top of
[`RecallExplorer/__init__.py`](../remote-script/RecallExplorer/__init__.py)
bound depth, object count, attributes per object, collection size, and work per
Live display update. A truncation is always written into the relevant node and
the final summary. For a targeted one-off pass, increase only the relevant
limit, redeploy, and restart Live. Restore the defaults afterwards.

The scan prioritizes the path through tracks, devices, mixer devices, and
parameters. Repetitive routing, Clip, and ClipSlot object types have their own
representative caps so a large project does not spend its global budget before
reaching its devices. Those caps are included in `run_started` and reported as
`type_limit:<type>` truncations in `run_completed`; a capped scan is useful for
discovering API surfaces, but not a complete inventory of every Set instance.

The explorer reads attributes and obtains method objects, but it never invokes
LOM methods, adds listeners, edits a Set, or sends data to Recall.
