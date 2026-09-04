// Tests for reading preset names out of a saved set.
//
// The fixtures reproduce the byte layout observed in a real 40MB set
// (`pers ep nightfall v4.als`, 23 plugin state blobs, 15 of them Serum 2):
// indented line-wrapped hex, a `XferJson` marker, flat JSON that is NOT
// terminated by a NUL, and the plugin's name recorded AFTER its own blob.

use super::*;

/// Wrap a blob the way Live writes it: uppercase hex, indented, 80 to a line.
fn as_live_hex(blob: &[u8]) -> String {
    let hex: String = blob.iter().map(|byte| format!("{byte:02X}")).collect();
    hex.as_bytes()
        .chunks(80)
        .map(|chunk| format!("\n\t\t\t\t\t{}", String::from_utf8_lossy(chunk)))
        .collect::<String>()
        + "\n\t\t\t\t"
}

/// A Serum state blob: marker, header JSON, then binary patch data.
///
/// The byte immediately after the closing brace is deliberately `(` — that is
/// what the real file holds, and it is why the parser cannot look for a NUL.
fn serum_blob(header: &str) -> Vec<u8> {
    let mut blob = b"XferJson\x01\x00\x00".to_vec();
    blob.extend_from_slice(header.as_bytes());
    blob.extend_from_slice(&[0x28, 0xFF, 0x00, 0x91, 0x7A]);
    blob
}

fn serum_header(name: &str, author: &str, description: &str, hash: &str) -> String {
    format!(
        r#"{{"component":"controller","hash":"{hash}","presetAuthor":"{author}","presetDescription":"{description}","presetName":"{name}","product":"Serum2","productVersion":"2.0.24","url":"https://xferrecords.com/","vendor":"Xfer Records","version":9.0}}"#
    )
}

fn device(plugin: &str, blob: &[u8]) -> String {
    format!(
        "<PluginDesc><Vst3PluginInfo><Preset><Vst3Preset><ControllerState>{}</ControllerState>\
         <Name Value=\"\" /><PresetRef /></Vst3Preset></Preset><Name Value=\"{plugin}\" />\
         </Vst3PluginInfo></PluginDesc>",
        as_live_hex(blob)
    )
}

fn track(kind: &str, name: &str, body: &str) -> String {
    format!(
        "<{kind} Id=\"23\" SelectedToolPanel=\"2\"><LomId Value=\"0\" />\
         <Name><EffectiveName Value=\"{name}\" /><UserName Value=\"\" /></Name>{body}</{kind}>"
    )
}

#[test]
fn reads_the_preset_name_a_producer_chose() {
    let xml = track(
        "MidiTrack",
        "Bass",
        &device(
            "Serum 2",
            &serum_blob(&serum_header(
                "perseus lead_drainpipe",
                "VELLUM",
                "BASS//TWO",
                "cf33dff0992a4320bcf2a4daaa5d8a4c",
            )),
        ),
    );

    let found = read_presets(&xml);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].preset_name, "perseus lead_drainpipe");
    assert_eq!(found[0].preset_author.as_deref(), Some("VELLUM"));
    assert_eq!(found[0].preset_bank.as_deref(), Some("BASS//TWO"));
    assert_eq!(found[0].plugin_name, "Serum 2");
    assert_eq!(found[0].track_name.as_deref(), Some("Bass"));
    assert_eq!(
        found[0].state_hash.as_deref(),
        Some("cf33dff0992a4320bcf2a4daaa5d8a4c")
    );
    assert_eq!(found[0].plugin_version.as_deref(), Some("2.0.24"));
}

#[test]
fn does_not_stop_at_a_null_that_is_not_there() {
    // The regression that made the first extraction attempt report nothing: the
    // header was read as NUL-terminated, but the byte after `}` is patch data.
    // Every Serum instance silently became "no preset found".
    let blob = serum_blob(&serum_header("Pad_1", "", "", "b5b86ab1"));
    assert!(
        !blob.contains(&0x00) || blob.iter().position(|b| *b == 0).unwrap() < 12,
        "fixture must have no NUL between the JSON and the end of the header"
    );
    let found = read_presets(&track("MidiTrack", "Keys", &device("Serum 2", &blob)));
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].preset_name, "Pad_1");
}

#[test]
fn leaves_out_the_fields_serum_left_empty() {
    // An unbranded user patch has no author and no bank. Empty strings would
    // render as a blank byline in the Timeline; absent is the honest shape.
    let found = read_presets(&track(
        "MidiTrack",
        "Sub",
        &device(
            "Serum 2",
            &serum_blob(&serum_header("S2alt_BS_5", "", "", "")),
        ),
    ));
    assert_eq!(found[0].preset_name, "S2alt_BS_5");
    assert_eq!(found[0].preset_author, None);
    assert_eq!(found[0].preset_bank, None);
    assert_eq!(found[0].state_hash, None);
}

#[test]
fn says_nothing_about_a_plugin_that_writes_no_readable_header() {
    // FabFilter and IK store their state opaquely. That is not an error and must
    // not become a fabricated or empty-named preset — they simply do not appear.
    let opaque: Vec<u8> = (0u8..=255).cycle().take(600).collect();
    let xml = track("AudioTrack", "Drums", &device("Pro-L 2", &opaque));
    assert_eq!(read_presets(&xml), vec![]);
}

#[test]
fn does_not_call_another_xfer_product_serum() {
    // XferJson identifies the vendor envelope. Product identifies the plugin.
    // A future Xfer device with the same readable keys must not leak into a
    // section whose contract is specifically "Serum 2 presets".
    let header = r#"{"product":"OTT2","presetName":"Wide master","hash":"1234"}"#;
    let xml = track(
        "AudioTrack",
        "Mastering",
        &device("OTT", &serum_blob(header)),
    );
    assert_eq!(read_presets(&xml), vec![]);
}

#[test]
fn keeps_every_instance_apart_and_on_its_own_track() {
    // The real set has fifteen Serum instances, several sharing one preset. Each
    // is its own device on its own track, so the reader must not collapse them.
    let xml = format!(
        "<Ableton>{}{}{}</Ableton>",
        track(
            "MidiTrack",
            "12-Serum 2",
            &device(
                "Serum 2",
                &serum_blob(&serum_header(
                    "Pers_Lead_stab",
                    "VELLUM",
                    "BASS//THREE",
                    "2c809dae"
                ))
            )
        ),
        track(
            "MidiTrack",
            "16-Serum 2",
            &device(
                "Serum 2",
                &serum_blob(&serum_header("PERS BASS_Bass_3", "", "", "334353f6"))
            )
        ),
        track(
            "MidiTrack",
            "25-Serum 2",
            &device(
                "Serum 2",
                &serum_blob(&serum_header(
                    "RKU_UKB_bass_lead_insanity",
                    "Renraku",
                    "UK Bass Aesthetics",
                    "30f53c9d"
                ))
            )
        ),
    );

    let found = read_presets(&xml);
    let named: Vec<(&str, &str)> = found
        .iter()
        .map(|preset| {
            (
                preset.track_name.as_deref().unwrap_or(""),
                preset.preset_name.as_str(),
            )
        })
        .collect();
    assert_eq!(
        named,
        vec![
            ("12-Serum 2", "Pers_Lead_stab"),
            ("16-Serum 2", "PERS BASS_Bass_3"),
            ("25-Serum 2", "RKU_UKB_bass_lead_insanity"),
        ]
    );
}

#[test]
fn the_hash_separates_an_edited_patch_from_a_renamed_one() {
    // Why the hash is carried at all. The name alone cannot tell "the producer
    // tweaked this patch" from "the producer renamed it", and those are opposite
    // facts in a version diff.
    let edited = read_presets(&track(
        "MidiTrack",
        "Bass",
        &device(
            "Serum 2",
            &serum_blob(&serum_header("Pad_1", "", "", "aaaa1111")),
        ),
    ));
    let renamed = read_presets(&track(
        "MidiTrack",
        "Bass",
        &device(
            "Serum 2",
            &serum_blob(&serum_header("Pad_2", "", "", "aaaa1111")),
        ),
    ));
    assert_eq!(edited[0].state_hash, renamed[0].state_hash);
    assert_ne!(edited[0].preset_name, renamed[0].preset_name);
}

#[test]
fn a_device_before_any_track_reports_no_track_rather_than_a_wrong_one() {
    // Master-chain and pre-track devices exist. Borrowing the first track's name
    // would put a preset on a track that never had it.
    let xml = format!(
        "<Ableton>{}{}</Ableton>",
        device("Serum 2", &serum_blob(&serum_header("Orphan", "", "", ""))),
        track("MidiTrack", "Bass", "")
    );
    let found = read_presets(&xml);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].track_name, None);
}

#[test]
fn a_master_device_belongs_to_master_not_the_last_audio_track() {
    let xml = format!(
        "<Ableton>{}{}</Ableton>",
        track("AudioTrack", "Drums", ""),
        track(
            "MasterTrack",
            "Master",
            &device(
                "Serum 2",
                &serum_blob(&serum_header("Reference tone", "", "", "master-1")),
            )
        )
    );
    let found = read_presets(&xml);
    assert_eq!(found[0].track_name.as_deref(), Some("Master"));
}

#[test]
fn survives_a_truncated_or_corrupt_blob() {
    // A half-written set must degrade to "nothing found", never panic.
    let xml = "<MidiTrack ><Name><EffectiveName Value=\"Bass\" /></Name>\
               <ControllerState>ABC</ControllerState><Name Value=\"Serum 2\" />";
    assert_eq!(read_presets(xml), vec![]);

    let unclosed = "<ControllerState>41424344";
    assert_eq!(read_presets(unclosed), vec![]);

    let not_hex = "<ControllerState>zzzz</ControllerState><Name Value=\"Serum 2\" />";
    assert_eq!(read_presets(not_hex), vec![]);
}

#[test]
fn reads_a_name_live_had_to_escape() {
    let xml = track(
        "MidiTrack",
        "Bass &amp; Sub",
        &device(
            "Serum 2",
            &serum_blob(&serum_header("Rip_Charlies_V1", "VELLUM", "", "ecf79cc2")),
        ),
    );
    let found = read_presets(&xml);
    assert_eq!(found[0].track_name.as_deref(), Some("Bass & Sub"));
}

#[test]
fn an_empty_preset_name_is_not_a_preset() {
    // Live's own `<Name Value="" />` beside the blob is empty for every VST3, and
    // an empty presetName would be the same non-answer wearing a better label.
    let xml = track(
        "MidiTrack",
        "Bass",
        &device(
            "Serum 2",
            &serum_blob(&serum_header("", "VELLUM", "", "aaaa")),
        ),
    );
    assert_eq!(read_presets(&xml), vec![]);
}

/// Run the reader against a real set on disk.
///
/// Ignored by default because it needs a file this repo cannot carry — a real
/// `.als` is tens of megabytes and is the producer's own work. Point it at one:
///
/// ```text
/// RECALL_ALS_FIXTURE="M:/Ableton Projects/…/song.als" cargo test -- --ignored --nocapture
/// ```
#[test]
#[ignore]
fn reads_a_real_set_from_disk() {
    let Ok(path) = std::env::var("RECALL_ALS_FIXTURE") else {
        panic!("set RECALL_ALS_FIXTURE to a real .als path");
    };
    let found = read_presets_from_file(&path).expect("the set should be readable");
    for preset in &found {
        println!(
            "{:<24} | {:<10} | {:<28} | {}",
            preset.track_name.as_deref().unwrap_or("—"),
            preset.plugin_name,
            preset.preset_name,
            preset.preset_author.as_deref().unwrap_or("—"),
        );
    }
    assert!(!found.is_empty(), "a set with plugins should yield presets");
}
