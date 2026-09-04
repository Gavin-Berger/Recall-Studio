// The preset name a producer actually chose, read back out of the saved set.
//
// WHY THIS IS NOT A LISTENER. Live exposes `PluginDevice.presets` and
// `selected_preset_index`, and they look like exactly the right answer. They are
// not: every VST3 in a real set reports the identical `["Default"]` / `0` —
// uniform across Xfer, FabFilter and IK, so it is how Live represents VST3
// programs generally rather than a quirk of one plugin. A listener on those
// attaches happily and fires never. Confirmed by a full LOM walk, 2026-09-03.
//
// Live's own `<Vst3Preset><Name Value="" />` field is empty for the same reason.
// The name was never Live's to hand over — the plugin owns its preset system and
// only ever hands Live an opaque state blob to store.
//
// But Serum writes a plain JSON header into the front of that blob, and Live
// stores the bytes faithfully. So the name survives a save, and this reads it.
//
// The consequence is that preset capture is SAVE-TIME, not realtime. A preset
// load emits no `parameter_changed` events at all, so no polling rate catches it
// live. Per-version is the honest granularity, and it happens to be the one the
// Timeline wants anyway: "at v3 the bass was X, at v4 it's Y" is a diff.

use serde::{Deserialize, Serialize};

/// A preset found on a device in a saved set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackPreset {
    /// The track the device sits on, when the set names one.
    pub track_name: Option<String>,
    /// The plugin, as Live records it beside the state blob ("Serum 2").
    pub plugin_name: String,
    /// What the producer picked ("perseus lead_drainpipe").
    pub preset_name: String,
    pub preset_author: Option<String>,
    /// Serum calls this `presetDescription`; in practice it holds the bank.
    pub preset_bank: Option<String>,
    /// Serum's own hash of the patch — a stable identity for the SOUND.
    ///
    /// Worth more than the name for diffing: same name with a changed hash is a
    /// patch the producer edited, and a changed name with the same hash is a
    /// rename. The name alone cannot tell those apart.
    pub state_hash: Option<String>,
    pub plugin_version: Option<String>,
}

/// Serum's header, as it appears at the front of the state blob.
#[derive(Deserialize)]
struct XferHeader {
    product: Option<String>,
    #[serde(rename = "presetName")]
    preset_name: Option<String>,
    #[serde(rename = "presetAuthor")]
    preset_author: Option<String>,
    #[serde(rename = "presetDescription")]
    preset_description: Option<String>,
    hash: Option<String>,
    #[serde(rename = "productVersion")]
    product_version: Option<String>,
}

/// A decompressed set can be tens of megabytes; a crafted one could be far more.
const MAX_DECOMPRESSED_BYTES: usize = 512 * 1024 * 1024;

/// Read every preset name out of a saved `.als`.
///
/// Returns an empty list rather than an error when a set simply has no plugin
/// whose format is understood — that is the ordinary case for a set of stock
/// devices, not a failure.
pub fn read_presets_from_file(path: &str) -> Result<Vec<TrackPreset>, String> {
    let file = std::fs::File::open(path).map_err(|err| format!("cannot open {path}: {err}"))?;
    let mut reader = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut xml = Vec::new();
    read_capped(&mut reader, &mut xml, MAX_DECOMPRESSED_BYTES)
        .map_err(|err| format!("cannot read {path}: {err}"))?;
    // Live writes UTF-8, but a truncated or partly-corrupt set should degrade to
    // "no presets found" rather than taking the caller down.
    Ok(read_presets(&String::from_utf8_lossy(&xml)))
}

fn read_capped(
    reader: &mut impl std::io::Read,
    into: &mut Vec<u8>,
    cap: usize,
) -> std::io::Result<()> {
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        if into.len() + read > cap {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "set is larger than Recall will decompress",
            ));
        }
        into.extend_from_slice(&chunk[..read]);
    }
}

/// The pure half: presets out of already-decompressed set XML.
pub fn read_presets(xml: &str) -> Vec<TrackPreset> {
    let tracks = track_starts(xml);
    let mut found = Vec::new();

    let mut cursor = 0usize;
    while let Some(open) = xml[cursor..].find("<ControllerState>") {
        let body_start = cursor + open + "<ControllerState>".len();
        let Some(body_end_rel) = xml[body_start..].find("</ControllerState>") else {
            break;
        };
        let body_end = body_start + body_end_rel;
        cursor = body_end;

        let Some(blob) = decode_hex(&xml[body_start..body_end]) else {
            continue;
        };
        let Some(header) = xfer_header(&blob) else {
            // Not a plugin that writes a readable header. Ordinary, not an error.
            continue;
        };
        // `XferJson` is a vendor marker, not a Serum marker. Other Xfer
        // products can use the same envelope, and calling one of their readable
        // strings a Serum preset would be exactly the kind of guess this reader
        // exists to avoid.
        if header.product.as_deref() != Some("Serum2") {
            continue;
        }
        let Some(preset_name) = header.preset_name.filter(|name| !name.is_empty()) else {
            continue;
        };

        found.push(TrackPreset {
            track_name: track_at(&tracks, body_start),
            // Live records the plugin's name AFTER the blob it belongs to.
            plugin_name: attribute_after(xml, body_end, "Name").unwrap_or_default(),
            preset_name,
            preset_author: header.preset_author.filter(|value| !value.is_empty()),
            preset_bank: header.preset_description.filter(|value| !value.is_empty()),
            state_hash: header.hash.filter(|value| !value.is_empty()),
            plugin_version: header.product_version.filter(|value| !value.is_empty()),
        });
    }

    found
}

/// Serum's header: the marker, then flat JSON, then the binary state.
///
/// The JSON is NOT null-terminated — the byte after the closing brace is just the
/// next byte of patch data, which is why this scans for the brace that closes the
/// object rather than for a terminator.
fn xfer_header(blob: &[u8]) -> Option<XferHeader> {
    let marker = find_bytes(blob, b"XferJson")?;
    let open = find_bytes(&blob[marker..], b"{")? + marker;

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in blob[open..].iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    let text = std::str::from_utf8(&blob[open..=open + offset]).ok()?;
                    return serde_json::from_str(text).ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Live wraps the hex across lines and indents it, so whitespace is skipped.
fn decode_hex(text: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(text.len() / 2);
    let mut high: Option<u8> = None;
    for character in text.bytes() {
        if character.is_ascii_whitespace() {
            continue;
        }
        let nibble = match character {
            b'0'..=b'9' => character - b'0',
            b'a'..=b'f' => character - b'a' + 10,
            b'A'..=b'F' => character - b'A' + 10,
            _ => return None,
        };
        match high {
            None => high = Some(nibble),
            Some(first) => {
                bytes.push((first << 4) | nibble);
                high = None;
            }
        }
    }
    // A trailing half-byte means the blob is truncated; trust none of it.
    if high.is_some() {
        return None;
    }
    Some(bytes)
}

/// Byte offset and name of every track, in document order.
fn track_starts(xml: &str) -> Vec<(usize, String)> {
    let mut starts = Vec::new();
    for tag in [
        "<MidiTrack ",
        "<AudioTrack ",
        "<ReturnTrack ",
        "<GroupTrack ",
        "<MasterTrack ",
        "<PreHearTrack ",
    ] {
        let mut cursor = 0usize;
        while let Some(found) = xml[cursor..].find(tag) {
            let at = cursor + found;
            cursor = at + tag.len();
            if let Some(name) = attribute_after(xml, at, "EffectiveName") {
                starts.push((at, name));
            }
        }
    }
    starts.sort_by_key(|(at, _)| *at);
    starts
}

/// The track a device at `position` belongs to: the last one opened before it.
///
/// Nesting means a device inside a group reports the innermost track opened
/// above it, which is the track a producer would name.
fn track_at(tracks: &[(usize, String)], position: usize) -> Option<String> {
    tracks
        .iter()
        .take_while(|(at, _)| *at < position)
        .last()
        .map(|(_, name)| name.clone())
}

/// The first non-empty `<Tag Value="..." />` at or after `from`.
///
/// NON-EMPTY, not first: Live writes a placeholder before the real thing. The
/// plugin name a device actually has is preceded by the preset's own name slot,
/// which is `<Name Value="" />` for every VST3 —
///
/// ```text
/// </ControllerState><Name Value="" /><PresetRef /></Vst3Preset></Preset>
/// <Name Value="Serum 2" />
/// ```
///
/// so stopping at the first match reads every plugin as nameless.
///
/// Bounded so a device with no name of its own cannot borrow one from far later
/// in the file.
fn attribute_after(xml: &str, from: usize, tag: &str) -> Option<String> {
    const WINDOW: usize = 8192;
    let end = xml.len().min(from + WINDOW);
    let slice = xml.get(from..end)?;
    let needle = format!("<{tag} Value=\"");

    let mut cursor = 0usize;
    while let Some(found) = slice[cursor..].find(&needle) {
        let at = cursor + found + needle.len();
        let rest = slice.get(at..)?;
        let Some(close) = rest.find('"') else {
            return None;
        };
        cursor = at + close;
        let value = &rest[..close];
        if !value.is_empty() {
            return Some(unescape_xml(value));
        }
    }
    None
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

#[cfg(test)]
#[path = "als_presets_tests.rs"]
mod tests;
