import type {
  ConnectionStatus,
  PlaybackState,
  SessionStats,
  SessionViewMode,
} from "../types/recall";

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
