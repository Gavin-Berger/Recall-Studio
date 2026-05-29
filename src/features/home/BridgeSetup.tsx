import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionStatus } from "../../types/recall";

type InstallTarget = { path: string; exists: boolean };
type InstallDetection = {
  candidates: InstallTarget[];
  recommended: string | null;
  bridge_version: string | null;
};
type InstallResult = {
  installed_dir: string;
  files: string[];
  bridge_version: string | null;
};

type BridgeSetupProps = {
  connection: ConnectionStatus;
};

export function BridgeSetup({ connection }: BridgeSetupProps) {
  const [path, setPath] = useState("");
  const [shippedVersion, setShippedVersion] = useState<string | null>(null);
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
        setShippedVersion(detection.bridge_version);
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

  const installedVersion = connection.bridge_version;

  return (
    <section className="bridge-setup">
      <header className="bridge-setup__header">
        <div>
          <span className="eyebrow">Ableton Bridge</span>
          <h2>The Max for Live device that feeds Recall Studio</h2>
        </div>
        <div className="bridge-setup__versions">
          {shippedVersion && (
            <span className="bridge-setup__chip">
              Ships v{shippedVersion}
            </span>
          )}
          {connection.connected && (
            <span className="bridge-setup__chip bridge-setup__chip--live">
              {installedVersion
                ? `Running v${installedVersion}`
                : "Connected"}
            </span>
          )}
        </div>
      </header>

      <div className="bridge-setup__columns">
        <div className="bridge-setup__block">
          <h3>What it needs</h3>
          <ul className="bridge-setup__list">
            <li>Ableton Live with Max for Live (Suite, or Live + Max add-on).</li>
            <li>This Recall Studio app running — it listens on localhost:9000.</li>
            <li>The device added to a track, then "start bridge" clicked.</li>
          </ul>
        </div>

        <div className="bridge-setup__block">
          <h3>Install</h3>
          <p className="bridge-setup__hint">
            Drops the device into your Ableton User Library. Path auto-detected —
            edit it if your Library lives elsewhere.
          </p>
          <label className="bridge-setup__field">
            <span>Ableton User Library</span>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={detected ? "Path to your User Library" : "Detecting…"}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="bridge-setup__btn"
            onClick={handleInstall}
            disabled={installing || !path.trim()}
          >
            {installing ? "Installing…" : "Install Bridge to Ableton"}
          </button>

          {result && (
            <p className="bridge-setup__ok">
              Installed{result.bridge_version ? ` v${result.bridge_version}` : ""}{" "}
              to <code>{result.installed_dir}</code>. Rescan Live's browser if it
              doesn't appear yet.
            </p>
          )}
          {error && <p className="bridge-setup__err">{error}</p>}
        </div>
      </div>

      <div className="bridge-setup__notes">
        <h3>Good to know</h3>
        <ul className="bridge-setup__list">
          <li>
            <strong>Today it's a MIDI Effect</strong> — Live only allows it on
            MIDI tracks. A master-chain Audio Effect version is coming.
          </li>
          <li>
            It reads Live via the Max LiveAPI and never touches your audio — no
            coloration, no signal processing.
          </li>
          <li>
            Raw telemetry is always preserved; your notes and edits are a layer
            on top, never overwriting the capture.
          </li>
          <li>
            After adding the device, click <strong>start bridge</strong> inside
            it to begin streaming.
          </li>
        </ul>
      </div>
    </section>
  );
}
