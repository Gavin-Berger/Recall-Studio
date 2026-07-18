import type {
  PreviewBounce,
  ReleasePreviewProject,
  ReleasePreviewTrack,
} from "./previewExport";

type ReleasePreviewProps<TBounce extends PreviewBounce> = {
  project: ReleasePreviewProject;
  tracks: ReleasePreviewTrack<TBounce>[];
  activeBounceId: string | null;
  isPlaying: boolean;
  progress: number;
  incompleteTrackCount: number;
  exporting: boolean;
  exportStatus: string | null;
  onBack: () => void;
  onExport: () => void;
  onPlay: (track: ReleasePreviewTrack<TBounce>) => void;
  onSeek: (track: ReleasePreviewTrack<TBounce>, fraction: number) => void;
};

function releaseTypeLabel(type: ReleasePreviewProject["releaseType"]) {
  return type === "ep" ? "EP" : type === "single" ? "Single" : "Album";
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function ReleasePreview<TBounce extends PreviewBounce>({
  project,
  tracks,
  activeBounceId,
  isPlaying,
  progress,
  incompleteTrackCount,
  exporting,
  exportStatus,
  onBack,
  onExport,
  onPlay,
  onSeek,
}: ReleasePreviewProps<TBounce>) {
  const totalDuration = tracks.reduce((total, track) => total + track.bounce.durationSec, 0);
  const releaseYear = project.releaseDate
    ? new Date(`${project.releaseDate}T12:00:00`).getFullYear()
    : null;

  return (
    <section className="release-preview" aria-label="Release preview">
      <header className="release-preview__toolbar">
        <button type="button" className="px-btn" onClick={onBack}>Back to organizer</button>
        <div>
          {exportStatus && <span className="release-preview__status" role="status">{exportStatus}</span>}
          <button
            type="button"
            className="px-btn px-btn--primary"
            disabled={exporting || tracks.length === 0}
            onClick={onExport}
          >
            {exporting ? "Exporting..." : "Export preview"}
          </button>
        </div>
      </header>

      <div
        className="release-preview__hero"
        style={project.coverImageDataUrl ? {
          backgroundImage: `linear-gradient(90deg, rgba(10, 13, 18, 0.4), rgba(10, 13, 18, 0.92)), url("${project.coverImageDataUrl}")`,
          backgroundPosition: "center",
          backgroundSize: "cover",
        } : undefined}
      >
        {project.coverImageDataUrl ? (
          <img src={project.coverImageDataUrl} alt={`${project.name || "Untitled release"} cover`} />
        ) : (
          <div className="release-preview__cover-empty" aria-label="No cover art">R</div>
        )}
        <div className="release-preview__identity">
          <span>{releaseTypeLabel(project.releaseType)}</span>
          <h2>{project.name.trim() || "Untitled release"}</h2>
          <strong>{project.artist.trim() || "Unknown artist"}</strong>
          <p>
            {tracks.length} track{tracks.length === 1 ? "" : "s"}
            {releaseYear ? ` · ${releaseYear}` : ""}
            {totalDuration > 0 ? ` · ${formatDuration(totalDuration)}` : ""}
          </p>
        </div>
      </div>

      {project.notes.trim() && <p className="release-preview__notes">{project.notes}</p>}

      {incompleteTrackCount > 0 && (
        <p className="release-preview__incomplete">
          {incompleteTrackCount} track{incompleteTrackCount === 1 ? "" : "s"} omitted because no final version is selected.
        </p>
      )}

      {tracks.length === 0 ? (
        <div className="release-preview__empty">
          <strong>No final mixes selected.</strong>
          <p>Mark a version final on each track before exporting the release preview.</p>
        </div>
      ) : (
        <ol className="release-preview__tracks">
          {tracks.map((track, index) => {
            const active = activeBounceId === track.bounce.id;
            const trackProgress = active ? progress : 0;
            return (
              <li key={track.trackId} className={active ? "is-active" : undefined}>
                <button
                  type="button"
                  className="release-preview__play"
                  aria-label={active && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                  onClick={() => onPlay(track)}
                >
                  {active && isPlaying ? "❚❚" : "▶"}
                </button>
                <span className="release-preview__number">{String(index + 1).padStart(2, "0")}</span>
                <div className="release-preview__track-title">
                  <strong>{track.title}</strong>
                  <span>{project.artist.trim() || "Unknown artist"}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.001"
                  value={trackProgress}
                  aria-label={`Seek ${track.title}`}
                  onChange={(event) => onSeek(track, Number(event.target.value))}
                />
                <time>{formatDuration(track.bounce.durationSec)}</time>
              </li>
            );
          })}
        </ol>
      )}

      <footer className="release-preview__footer">Private release preview · Recall Studio</footer>
    </section>
  );
}
