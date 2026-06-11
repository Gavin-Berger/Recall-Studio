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
          <span className="eyebrow">Ableton to schema</span>
          <h2>The Max for Live bridge feeds the normalized timeline.</h2>
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
          <h3>Pipeline</h3>
          <ul className="bridge-setup__list">
            <li>Ableton sends track, device, and parameter observations.</li>
            <li>Rust normalizes useful events into the Recall Studio schema.</li>
            <li>The frontend renders the stored schema as a creative timeline.</li>
          </ul>
        </div>

        <div className="bridge-setup__block">
          <h3>Install</h3>
          <p className="bridge-setup__hint">
            Drops the bridge device into your Ableton User Library. Path
            auto-detected; edit it if your Library lives elsewhere.
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
        <h3>Schema focus</h3>
        <ul className="bridge-setup__list">
          <li>
            <strong>Device roles matter</strong>: instrument, MIDI effect, and
            audio effect are displayed separately in the timeline.
          </li>
          <li>
            Raw Ableton data is only evidence; the app view is the normalized
            Recall Studio schema.
          </li>
          <li>
            Creative moments sit on top of tracks, devices, parameters, and
            before/after changes.
          </li>
          <li>
            The current milestone is clarity: store the schema and make the
            timeline easy to read.
          </li>
        </ul>
      </div>
    </section>
  );
}
