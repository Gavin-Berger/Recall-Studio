import type { RecallEventType, RecallTimelineMoment } from "../types/recall";

export type ProducerEventCategory =
  | "track"
  | "group"
  | "device"
  | "parameter"
  | "clip"
  | "scene"
  | "mixer"
  | "arrangement"
  | "transport"
  | "tempo"
  | "project"
  | "session"
  | "unknown";

export type ProducerEventPresentation = {
  category: ProducerEventCategory;
  categoryLabel: string;
  title: string;
  detail?: string;
  contextLabel: string;
  metadataPills: Array<{ label: string; value: string }>;
};

const NOISE_PATTERNS = [
  "heartbeat",
  "screen capture",
  "screenshot",
  "captured screenshot",
  "image capture",
  "screen_shot",
  "screen-shot",
  "debug",
  "poll",
  "ping",
  "raw packet",
];

const SNAPSHOT_EVENT_TYPES = new Set([
  "transport_snapshot",
  "live_set_snapshot",
  "set_snapshot",
  "session_snapshot",
]);

const IMPORTANT_EVENT_TYPES = new Set<RecallEventType>([
  // transport (play/stop) excluded — too frequent to be a creative signal
  "tempo",
  "track",
  "group",
  "device",
  "parameter",
  "clip",
  "scene",
  "mixer",
  "arrangement",
  "creative_moment",
]);

export function isProducerTimelineEvent(event: RecallTimelineMoment): boolean {
  if (event.type === "heartbeat" || event.timelineRole === "debug") {
    return false;
  }

  // Track *selection / focus* is navigation, not a creative decision — it's the
  // moment producers hide most. Keep persisting it (raw telemetry is preserved)
  // but exclude it from the curated document. This covers both the discrete
  // track_selected event and the periodic selected_track_focus_snapshot, which
  // otherwise falls through type inference to "track" and renders as a bogus
  // "Track selected" row. Real track events (created, renamed, deleted) still
  // pass through below.
  const rawNav = event.rawEventType?.toLowerCase();
  if (
    rawNav === "track_selected" ||
    rawNav === "selected_track_focus_snapshot" ||
    rawNav === "selected_track_snapshot"
  ) {
    return false;
  }

  // Track lifecycle events are always creative decisions — always show them.
  const TRACK_LIFECYCLE = new Set([
    "track_created", "track_deleted", "track_name_changed",
    "track_muted", "track_unmuted", "track_soloed", "track_unsoloed",
    "track_armed", "track_unarmed",
  ]);
  if (rawNav && TRACK_LIFECYCLE.has(rawNav)) {
    return true;
  }

  // Automation creation is always a creative decision.
  if (rawNav === "automation_created") {
    return true;
  }

  const searchable = [
    event.type,
    event.rawEventType,
    event.summary,
    event.detail,
    event.source,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (NOISE_PATTERNS.some((pattern) => searchable.includes(pattern))) {
    return false;
  }

  const rawType = event.rawEventType?.toLowerCase();

  if (rawType && SNAPSHOT_EVENT_TYPES.has(rawType)) {
    return isMeaningfulStateChange(event);
  }

  if (event.timelineRole === "context") {
    return isMeaningfulStateChange(event);
  }

  if (event.type === "unknown") {
    return hasProducerContext(event);
  }

  return IMPORTANT_EVENT_TYPES.has(event.type);
}

export function formatProducerMoment(
  event: RecallTimelineMoment,
): ProducerEventPresentation {
  const category = categoryForEvent(event.type);
  const categoryLabel = labelForCategory(category);
  const track = event.trackName ?? readString(event.metadata?.track);
  const groupPath = event.groupPath ?? readStringArray(event.metadata?.groupPath);
  const group =
    event.groupName ??
    readString(event.metadata?.group) ??
    (groupPath?.length ? groupPath[groupPath.length - 1] : undefined);
  const device = event.deviceName ?? readString(event.metadata?.device);
  const deviceChain = event.deviceChain ?? readString(event.metadata?.deviceChain);
  const parameter = readString(event.metadata?.parameter);
  const clip = readString(event.metadata?.clip);
  const sample = readString(event.metadata?.sample);
  const position =
    readString(event.metadata?.position) ??
    readString(event.metadata?.arrangementPosition);
  const projectClock = readString(event.metadata?.projectClock);
  const tempo = formatBpm(event.metadata?.bpm);
  const value = formatPrimitive(event.metadata?.value);
  const groupText = groupPath?.length ? groupPath.join(" / ") : group;

  let title = event.summary;
  let detail = event.detail;

  switch (event.type) {
    case "track": {
      const rawType = event.rawEventType?.toLowerCase();
      const named = track ? `"${track}"` : "the track";

      if (rawType === "track_created") {
        title = track ? `Added track "${track}"` : "Made a new track";
        detail = track ? `Created a new track, "${track}".` : "Created a new track.";
      } else if (rawType === "track_deleted") {
        title = track ? `Deleted "${track}"` : "Deleted a track";
        detail = track ? `Removed the track "${track}".` : "Removed a track.";
      } else if (rawType === "track_name_changed") {
        title = track ? `Renamed to "${track}"` : "Renamed a track";
        detail = track ? `Renamed a track to "${track}".` : "Renamed a track.";
      } else if (rawType === "track_muted") {
        title = `Muted ${named}`;
        detail = `Muted ${named}.`;
      } else if (rawType === "track_unmuted") {
        title = `Unmuted ${named}`;
        detail = `Brought ${named} back in.`;
      } else if (rawType === "track_soloed") {
        title = `Soloed ${named}`;
        detail = `Soloed ${named} to hear it on its own.`;
      } else if (rawType === "track_unsoloed") {
        title = `Took ${named} off solo`;
        detail = `Took ${named} off solo.`;
      } else if (rawType === "track_armed") {
        title = `Armed ${named} to record`;
        detail = `Armed ${named} for recording.`;
      } else if (rawType === "track_unarmed") {
        title = `Disarmed ${named}`;
        detail = `Disarmed ${named}.`;
      } else {
        // track_selected / focus snapshot — navigation context, normally hidden.
        title = "Track selected";
        detail = track
          ? groupText
            ? `Selected "${track}" inside ${groupText}.`
            : `Selected "${track}".`
          : "Track focus changed in Ableton.";
      }
      break;
    }

    case "group":
      title = "Group focus changed";
      detail = groupText
        ? `Focused the ${groupText} track group.`
        : "A track group became part of the session focus.";
      break;

    case "device": {
      const rawType = event.rawEventType?.toLowerCase();
      const where = track ? (groupText ? `"${track}" inside ${groupText}` : `"${track}"`) : null;

      if (rawType === "device_chain_changed") {
        title = "Reworked the chain";
        detail = deviceChain
          ? where
            ? `Chain on ${where} is now ${deviceChain}.`
            : `Chain is now ${deviceChain}.`
          : "Changed the chain on the selected track.";
      } else if (rawType === "device_added") {
        title = device ? `Added ${device}` : "Added a device";
        detail = buildChainEdit("Added", device, where, deviceChain);
      } else if (rawType === "device_removed") {
        title = device ? `Removed ${device}` : "Removed a device";
        detail = buildChainEdit("Removed", device, where, deviceChain);
      } else {
        title = device ? `Worked on ${device}` : "Worked on a device";
        detail = buildDeviceDetail(device, track, groupText);
      }
      break;
    }

    case "parameter": {
      const rawType = event.rawEventType?.toLowerCase();
      if (rawType === "automation_created" || rawType === "automation_edited") {
        const verb = rawType === "automation_edited" ? "Reworked automation on" : "Automated";
        title = parameter ? `${verb} ${parameter}` : (rawType === "automation_edited" ? "Reworked automation" : "Wrote automation");
        detail = buildAutomationDetail(parameter, device, track, groupText, position);
      } else {
        title = parameter ? `Tweaked ${parameter}` : "Tweaked a control";
        detail = buildParameterDetail(parameter, device, track, groupText, value);
      }
      break;
    }

    case "clip": {
      const rawType = event.rawEventType?.toLowerCase();
      const where = track ? (groupText ? `"${track}" inside ${groupText}` : `"${track}"`) : null;

      if (rawType === "sample_added") {
        const name = sample ?? clip;
        title = name ? `Dropped in ${name}` : "Dropped in a sample";
        detail = name
          ? `Dropped "${name}"${where ? ` onto ${where}` : ""}.`
          : "Added a sample to a track.";
      } else if (rawType === "audio_clip_added") {
        title = "Added an audio clip";
        detail = `Added an audio clip${where ? ` to ${where}` : ""}.`;
      } else if (rawType === "midi_clip_created") {
        title = clip ? `New MIDI clip "${clip}"` : "Started a MIDI clip";
        detail = `Started a new MIDI clip${where ? ` on ${where}` : ""}.`;
      } else if (rawType === "clip_created") {
        title = clip ? `Made the clip "${clip}"` : "Made a clip";
        detail = buildClipDetail(clip, track, groupText);
      } else if (rawType === "clip_deleted") {
        title = clip ? `Deleted "${clip}"` : "Deleted a clip";
        detail = `Deleted a clip${where ? ` on ${where}` : ""}.`;
      } else {
        title = clip ? `Launched "${clip}"` : "Launched a clip";
        detail = buildClipDetail(clip, track, groupText);
      }
      break;
    }

    case "scene":
      title = "Launched a scene";
      detail = "Launched a scene in Session View.";
      break;

    case "mixer":
      title = "Mixer changed";
      detail = track
        ? `Mixer state changed on "${track}"${groupText ? ` inside ${groupText}` : ""}.`
        : "Mixer state changed in Ableton.";
      break;

    case "transport":
      title = readBoolean(event.metadata?.playing) === false ? "Playback stopped" : "Playback started";
      detail = projectClock
        ? `Arrangement playback ${readBoolean(event.metadata?.playing) === false ? "stopped" : "started"} at ${projectClock}${position ? ` (${position})` : ""}.`
        : "Arrangement playback state changed.";
      break;

    case "tempo":
      title = tempo ? `Changed the tempo to ${tempo}` : "Changed the tempo";
      detail = projectClock
        ? `Changed the tempo at ${projectClock}${position ? ` (${position})` : ""}.`
        : "Changed the project tempo.";
      break;

    case "session":
      title = "Live Set changed";
      detail = "Session-level Ableton state changed.";
      break;

    case "file":
      title = "Project file changed";
      detail = event.detail ?? "Ableton project file activity was captured.";
      break;

    default:
      title = sanitizeFallbackTitle(event.summary);
      detail = event.detail;
      break;
  }

  return {
    category,
    categoryLabel,
    title,
    detail,
    contextLabel: buildContextLabel(track, groupText, device, event.source),
    metadataPills: buildProducerPills({
      groupText,
      track,
      device,
      deviceChain,
      parameter,
      clip,
      sample,
      tempo,
      projectClock,
      position,
      value,
    }),
  };
}

export function categoryForEvent(type: RecallEventType): ProducerEventCategory {
  switch (type) {
    case "file":
      return "project";
    case "creative_moment":
      return "session";
    case "heartbeat":
      return "unknown";
    default:
      return type;
  }
}

export function producerEventIcon(type: RecallEventType): string {
  switch (categoryForEvent(type)) {
    case "track":
      return "T";
    case "group":
      return "G";
    case "device":
      return "D";
    case "parameter":
      return "P";
    case "transport":
      return ">";
    case "tempo":
      return "B";
    case "clip":
      return "C";
    case "scene":
      return "S";
    case "mixer":
      return "M";
    case "project":
      return "F";
    case "session":
      return "L";
    default:
      return "M";
  }
}

function hasProducerContext(event: RecallTimelineMoment): boolean {
  return Boolean(
    event.trackName ||
      event.groupName ||
      event.groupPath?.length ||
      event.deviceName ||
      readString(event.metadata?.track) ||
      readString(event.metadata?.group) ||
      readStringArray(event.metadata?.groupPath)?.length ||
      readString(event.metadata?.device) ||
      readString(event.metadata?.parameter) ||
      readString(event.metadata?.clip),
  );
}

function isMeaningfulStateChange(event: RecallTimelineMoment): boolean {
  return (
    event.type === "tempo" ||
    event.type === "transport" ||
    event.type === "track" ||
    event.type === "group" ||
    event.type === "device" ||
    event.type === "parameter" ||
    event.type === "clip" ||
    event.type === "scene" ||
    event.type === "mixer"
  );
}

export function labelForCategory(category: ProducerEventCategory): string {
  switch (category) {
    case "track":
      return "Track";
    case "group":
      return "Group";
    case "device":
      return "Device";
    case "parameter":
      return "Parameter";
    case "clip":
      return "Clip";
    case "scene":
      return "Scene";
    case "mixer":
      return "Mixer";
    case "arrangement":
      return "Arrangement";
    case "transport":
      return "Transport";
    case "tempo":
      return "Tempo";
    case "project":
      return "Project";
    case "session":
      return "Live Set";
    default:
      return "Telemetry";
  }
}

function buildDeviceDetail(
  device?: string,
  track?: string,
  group?: string,
): string {
  if (device && track && group) {
    return `${device} activity on "${track}" inside ${group}.`;
  }

  if (device && track) {
    return `${device} activity on "${track}".`;
  }

  if (device) {
    return `${device} device activity was captured.`;
  }

  return "Device-level session activity was captured.";
}

function buildChainEdit(
  verb: "Added" | "Removed",
  device?: string,
  where?: string | null,
  chain?: string,
): string {
  const base = device
    ? `${verb} ${device}${where ? ` on ${where}` : ""}.`
    : `${verb} a device${where ? ` on ${where}` : ""}.`;

  return chain ? `${base} Chain: ${chain}.` : base;
}

function buildParameterDetail(
  parameter?: string,
  device?: string,
  track?: string,
  group?: string,
  value?: string,
): string {
  const changed = value ? `changed to ${value}` : "changed";

  if (parameter && device && track && group) {
    return `${parameter} on ${device} ${changed} on "${track}" inside ${group}.`;
  }

  if (parameter && device && track) {
    return `${parameter} on ${device} ${changed} on "${track}".`;
  }

  if (parameter && device) {
    return `${parameter} on ${device} ${changed}.`;
  }

  if (parameter) {
    return `${parameter} ${changed}.`;
  }

  return "A device or mixer control changed in Ableton.";
}

function buildAutomationDetail(
  parameter?: string,
  device?: string,
  track?: string,
  group?: string,
  position?: string,
): string {
  const where = track ? (group ? `"${track}" inside ${group}` : `"${track}"`) : null;
  const at = position ? ` at ${position}` : "";

  if (parameter && device && where) {
    return `Automation written on ${parameter} (${device}) on ${where}${at}.`;
  }
  if (parameter && device) {
    return `Automation written on ${parameter} (${device})${at}.`;
  }
  if (parameter) {
    return `Automation written on ${parameter}${at}.`;
  }
  return `Automation was written${where ? ` on ${where}` : ""}${at}.`;
}

function buildClipDetail(
  clip?: string,
  track?: string,
  group?: string,
): string {
  if (clip && track && group) {
    return `Launched "${clip}" on "${track}" inside ${group}.`;
  }

  if (clip && track) {
    return `Launched "${clip}" on "${track}".`;
  }

  if (clip) {
    return `Launched "${clip}".`;
  }

  if (track) {
    return `Clip activity on "${track}".`;
  }

  return "Clip activity was captured in Ableton.";
}

function buildContextLabel(
  track?: string,
  group?: string,
  device?: string,
  source?: string,
): string {
  if (track && group) return `${group} / ${track}`;
  if (track) return track;
  if (group) return group;
  if (device) return device;
  return source ?? "Ableton";
}

function buildProducerPills(input: {
  groupText?: string;
  track?: string;
  device?: string;
  deviceChain?: string;
  parameter?: string;
  clip?: string;
  sample?: string;
  tempo?: string;
  projectClock?: string;
  position?: string;
  value?: string;
}) {
  const pills: Array<{ label: string; value: string }> = [];

  addPill(pills, "Group", input.groupText);
  addPill(pills, "Track", input.track);
  addPill(pills, "Device", input.device);
  addPill(pills, "Chain", input.deviceChain);
  addPill(pills, "Parameter", input.parameter);
  addPill(pills, "Sample", input.sample);
  addPill(pills, "Clip", input.clip);
  addPill(pills, "Tempo", input.tempo);
  addPill(pills, "Time", input.projectClock);
  addPill(pills, "Position", input.position);
  addPill(pills, "Value", input.value);

  return pills.slice(0, 5);
}

function addPill(
  pills: Array<{ label: string; value: string }>,
  label: string,
  value?: string,
) {
  if (!value || pills.some((pill) => pill.label === label && pill.value === value)) {
    return;
  }

  pills.push({ label, value });
}

function sanitizeFallbackTitle(title: string): string {
  if (!title.trim()) {
    return "Ableton move captured";
  }

  return title.replace(/\bsong time\s+[0-9.]+\s+beats,?\s*/i, "").trim();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );

  return strings.length > 0 ? strings : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatBpm(value: unknown): string | undefined {
  return typeof value === "number" ? `${formatNumber(value)} BPM` : undefined;
}

function formatPrimitive(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  if (typeof value === "number") {
    return formatNumber(value);
  }

  return undefined;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
}
