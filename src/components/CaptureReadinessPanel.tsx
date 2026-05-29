import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionStatus,
  PlaybackState,
  SessionStats,
  SessionViewMode,
} from "../types/recall";

type InstallTarget = { path: string; exists: boolean };
type InstallDetection = {
  candidates: InstallTarget[];
  recommended: string | null;
};
type InstallResult = {
  installed_dir: string;
  files: string[];
  bridge_version: string | null;
};

type CaptureReadinessPanelProps = {
  connection: ConnectionStatus;
  playback: PlaybackState;
  stats: SessionStats;
  viewMode: SessionViewMode;
};

export function CaptureReadinessPanel({
  connection,
  playback,
  stats,
  viewMode,
}: CaptureReadinessPanelProps) {
  const readinessSteps = [
    {
      label: "Max for Live bridge",
      detail: connection.connected ? "Signal is reaching Recall Studio." : "Waiting for UDP signal on port 9000.",
      complete: connection.connected,
    },
    {
      label: "Transport context",
      detail:
        playback.playing === null
          ? "Start or stop playback in Ableton."
          : `Transport is ${playback.playing ? "playing" : "stopped"}.`,
      complete: playback.playing !== null,
    },
    {
      label: "Creative move",
      detail:
        stats.creativeEvents > 0
          ? `${stats.creativeEvents} timecoded moves captured.`
          : "Select a track, change tempo, open a device, or launch a clip.",
      complete: stats.creativeEvents > 0,
    },
  ];

  return (
    <section className="capture-readiness">
      <div className="capture-readiness__promise">
        <p className="eyebrow">
          {viewMode === "live" ? "First Capture" : "Session Empty"}
        </p>
        <h2>Remember every creative move in Ableton.</h2>
        <span>
          Recall Studio turns track selections, device work, parameter edits,
          tempo changes, clips, and playback decisions into a timecoded session
          memory.
        </span>
      </div>

      {viewMode === "live" && !connection.connected && <BridgeInstaller />}

      <div className="capture-readiness__steps">
        {readinessSteps.map((step) => (
          <div className={step.complete ? "is-complete" : ""} key={step.label}>
            <i />
            <span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
          </div>
        ))}
      </div>

      <div className="capture-readiness__try">
        <span>Try this in Ableton</span>
        <div>
          <strong>1</strong>
          <p>Select a track in your Live Set.</p>
        </div>
        <div>
          <strong>2</strong>
          <p>Start playback or change tempo.</p>
        </div>
        <div>
          <strong>3</strong>
          <p>Open a device or adjust a parameter.</p>
        </div>
      </div>

      <div className="capture-readiness__preview">
        <span>Document preview</span>
        <pre>{buildPreviewText(playback)}</pre>
      </div>
    </section>
  );
}

function BridgeInstaller() {
  const [path, setPath] = useState("");
  const [detected, setDetected] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<InstallDetection>("detect_bridge_install_targets")
      .then((detection) => {
        if (cancelled) return;
        if (detection.recommended) setPath(detection.recommended);
        setDetected(true);
      })
      .catch(() => {
        if (!cancelled) setDetected(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    setResult(null);
    try {
      const res = await invoke<InstallResult>("install_bridge", {
        targetRoot: path,
      });
      setResult(res);
    } catch (e) {
      setError(typeof e === "string" ? e : "Install failed.");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="bridge-installer">
      <div className="bridge-installer__head">
        <span className="eyebrow">Step 1 — Install the Ableton bridge</span>
        <p>
          Drops the Recall Studio device into your Ableton User Library. Then in
          Live: add it to a track from the browser and hit <strong>start
          bridge</strong>.
        </p>
      </div>

      <label className="bridge-installer__field">
        <span>Ableton User Library</span>
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={
            detected ? "Path to your Ableton User Library" : "Detecting…"
          }
          spellCheck={false}
        />
      </label>

      <button
        type="button"
        className="bridge-installer__btn"
        onClick={handleInstall}
        disabled={installing || !path.trim()}
      >
        {installing ? "Installing…" : "Install Bridge to Ableton"}
      </button>

      {result && (
        <p className="bridge-installer__ok">
          Installed{result.bridge_version ? ` v${result.bridge_version}` : ""} to{" "}
          <code>{result.installed_dir}</code>. Restart Live (or rescan the
          browser) if it doesn't appear yet.
        </p>
      )}

      {error && <p className="bridge-installer__err">{error}</p>}
    </div>
  );
}

function buildPreviewText(playback: PlaybackState): string {
  const position = playback.arrangementPosition ?? "Bar 1 Beat 1";
  const clock = playback.projectClock ?? "0:04";
  const tempo =
    typeof playback.tempo === "number" ? `${formatNumber(playback.tempo)} BPM` : "project tempo";

  return [
    "Recall Studio - Session Notes",
    "",
    `${clock}  Playback started at ${position}.`,
    "0:11  Bass track was selected.",
    `0:18  Device work captured at ${tempo}.`,
  ].join("\n");
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
}
