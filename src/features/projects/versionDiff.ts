// Structural compare between two takes' schema snapshots, in producer terms:
// which tracks and devices were added or removed. This is intentionally coarse —
// it only claims what two real snapshots can prove. Parameter-level and clip-level
// compare need richer per-take snapshot data and are not faked here.

import type { DeviceObj, ProjectSchema, TrackObj } from "../../types/schema";

export type DeviceChange = {
  device: string;
  track: string;
};

export type VersionDiff = {
  addedTracks: string[];
  removedTracks: string[];
  addedDevices: DeviceChange[];
  removedDevices: DeviceChange[];
};

export function diffIsEmpty(diff: VersionDiff): boolean {
  return (
    diff.addedTracks.length === 0 &&
    diff.removedTracks.length === 0 &&
    diff.addedDevices.length === 0 &&
    diff.removedDevices.length === 0
  );
}

export function trackLabel(track: TrackObj): string {
  const name = track.name?.trim();
  return name && name.length > 0 ? name : `Track ${track.number}`;
}

function deviceLabel(device: DeviceObj): string {
  const name = device.name?.trim();
  return name && name.length > 0 ? name : "Device";
}

// Tracks match by type + name (case-insensitive). A renamed track therefore reads
// as removed + added — honest given snapshots carry no cross-version identity yet.
function trackKey(track: TrackObj): string {
  return `${track.type}:${trackLabel(track).toLowerCase()}`;
}

export function compareSchemas(previous: ProjectSchema, next: ProjectSchema): VersionDiff {
  // Pool previous tracks by key so duplicate names pair one-to-one.
  const prevPool = new Map<string, TrackObj[]>();
  for (const track of previous.tracks) {
    const key = trackKey(track);
    const pool = prevPool.get(key);
    if (pool) pool.push(track);
    else prevPool.set(key, [track]);
  }

  const addedTracks: string[] = [];
  const matched: Array<[TrackObj, TrackObj]> = [];
  for (const track of next.tracks) {
    const pool = prevPool.get(trackKey(track));
    const prevTrack = pool?.shift();
    if (prevTrack) matched.push([prevTrack, track]);
    else addedTracks.push(trackLabel(track));
  }
  const removedTracks = [...prevPool.values()].flat().map(trackLabel);

  // Devices compare within matched tracks only: devices on an added/removed track
  // are implied by the track change and would be noise repeated here.
  const addedDevices: DeviceChange[] = [];
  const removedDevices: DeviceChange[] = [];
  for (const [prevTrack, nextTrack] of matched) {
    const pool = new Map<string, { label: string; count: number }>();
    for (const device of prevTrack.devices) {
      const label = deviceLabel(device);
      const key = label.toLowerCase();
      const entry = pool.get(key);
      if (entry) entry.count += 1;
      else pool.set(key, { label, count: 1 });
    }
    for (const device of nextTrack.devices) {
      const label = deviceLabel(device);
      const entry = pool.get(label.toLowerCase());
      if (entry && entry.count > 0) {
        entry.count -= 1;
      } else {
        addedDevices.push({ device: label, track: trackLabel(nextTrack) });
      }
    }
    for (const entry of pool.values()) {
      for (let i = 0; i < entry.count; i += 1) {
        removedDevices.push({ device: entry.label, track: trackLabel(prevTrack) });
      }
    }
  }

  return { addedTracks, removedTracks, addedDevices, removedDevices };
}

export function countDevices(schema: ProjectSchema): number {
  return schema.tracks.reduce((total, track) => total + track.devices.length, 0);
}
