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
  const [candidates, setCandidates] = useState<InstallTarget[]>([]);
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
        setCandidates(detection.candidates.filter((candidate) => candidate.exists));
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
          <span className="eyebrow">Ableton bridge</span>
          <h2>The Max for Live bridge keeps Recall in sync with Ableton.</h2>
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
          <h3>How it works</h3>
          <ul className="bridge-setup__list">
            <li>Ableton shares tracks, devices, and knob moves as you work.</li>
            <li>Recall keeps the useful moves and filters out the noise.</li>
            <li>You get a readable timeline of sounds, routing, and ideas.</li>
          </ul>
        </div>

        <div className="bridge-setup__block">
          <h3>Install</h3>
          <p className="bridge-setup__hint">
            Installs the bridge device into your Ableton User Library. Change
            the path if you keep your Library somewhere else.
          </p>
          <label className="bridge-setup__field">
            <span>Ableton User Library</span>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={detected ? "Path to your User Library" : "Detecting..."}
              spellCheck={false}
            />
          </label>
          {candidates.length > 1 && (
            <div className="bridge-setup__candidates" role="group" aria-label="Detected User Libraries">
              {candidates.map((candidate) => (
                <button
                  key={candidate.path}
                  type="button"
                  className={`bridge-setup__candidate ${candidate.path === path ? "is-on" : ""}`}
                  onClick={() => setPath(candidate.path)}
                  title={candidate.path}
                >
                  {candidate.path}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="bridge-setup__btn"
            onClick={handleInstall}
            disabled={installing || !path.trim()}
          >
            {installing ? "Installing..." : "Install Bridge"}
          </button>

          {result && (
            <div className="bridge-setup__ok">
              <p>
                Installed{result.bridge_version ? ` v${result.bridge_version}` : ""} to{" "}
                <code>{result.installed_dir}</code>.
              </p>
              <p>
                In Live: User Library → Presets → Audio Effects → Max Audio Effect →
                drag <strong>RECALL</strong> onto your master track (or any audio track).
                The connection light above turns green when it's talking to Recall.
              </p>
            </div>
          )}
          {error && <p className="bridge-setup__err">{error}</p>}
        </div>
      </div>

      <div className="bridge-setup__notes">
        <h3>What to expect</h3>
        <ul className="bridge-setup__list">
          <li>
            <strong>Tracks stay organized</strong>: instruments, MIDI tools,
            and audio effects keep their own lanes in the timeline.
          </li>
          <li>
            Recall turns the busy Ableton details into a timeline you can read
            after the session.
          </li>
          <li>
            Saved moments can point back to the track, device, control, and
            before/after move.
          </li>
          <li>
            The goal is simple: keep the important decisions easy to find when
            you come back.
          </li>
        </ul>
      </div>
    </section>
  );
}
