import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { analyzeAudioFile } from "./audio";
import { Waveform } from "./Waveform";

// The Project Organizer: a place to lay out a release as the thing you ship — a
// name, the Ableton sets that make it up, and the bounces you exported, each
// shown like a mix-review file (waveform + loudness + range + level). A project
// holds many sets, because this is about organization (an EP is several songs),
// not linking one file.
//
// Storage tier: localStorage, same as the producer notebook (NotesScreen). The
// derived analysis (waveform envelope + LUFS) is tiny and persists; the audio
// bytes themselves are not stored, so playback is available in the session that
// attached the file. Moving bounces into durable storage is the follow-up.

type AlsFile = {
  id: string;
  path: string;
  name: string;
};

type ExportBounce = {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  durationSec: number;
  sampleRate: number;
  channelCount: number;
  peaks: number[];
  integratedLufs: number | null;
  dynamicRangeLu: number | null;
  peakDb: number;
  added_at_ms: number;
};

type OrganizerProject = {
  id: string;
  name: string;
  alsFiles: AlsFile[];
  exports: ExportBounce[];
  created_at_ms: number;
  updated_at_ms: number;
};

const STORAGE_KEY = "recall-studio.organizer.v1";

// Coerce a stored record into a project, tolerating older shapes. The v1 single
// link (alsPath/alsName) is migrated into the alsFiles list so early projects
// keep their set.
function normalizeProject(raw: unknown): OrganizerProject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string" || !Array.isArray(r.exports)) {
    return null;
  }

  let alsFiles: AlsFile[] = [];
  if (Array.isArray(r.alsFiles)) {
    alsFiles = r.alsFiles
      .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null && typeof f.path === "string")
      .map((f) => ({
        id: typeof f.id === "string" ? f.id : makeAlsId(),
        path: f.path as string,
        name: typeof f.name === "string" ? f.name : basename(f.path as string),
      }));
  } else if (typeof r.alsPath === "string") {
    alsFiles = [
      {
        id: makeAlsId(),
        path: r.alsPath,
        name: typeof r.alsName === "string" ? r.alsName : basename(r.alsPath),
      },
    ];
  }

  return {
    id: r.id,
    name: r.name,
    alsFiles,
    exports: r.exports as ExportBounce[],
    created_at_ms: typeof r.created_at_ms === "number" ? r.created_at_ms : Date.now(),
    updated_at_ms: typeof r.updated_at_ms === "number" ? r.updated_at_ms : Date.now(),
  };
}

function loadProjects(): OrganizerProject[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeProject).filter((p): p is OrganizerProject => p !== null);
  } catch {
    return [];
  }
}

function persistProjects(projects: OrganizerProject[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Storage can be full or unavailable; the in-memory copy still works.
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatLufs(lufs: number | null): string {
  return lufs === null ? "—" : `${lufs.toFixed(1)} LUFS`;
}

function formatLra(lra: number | null | undefined): string {
  return lra == null ? "—" : `${lra.toFixed(1)} LU`;
}

// Unique enough for a batch added in the same millisecond.
function makeExportId(index: number): string {
  return `exp-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeAlsId(): string {
  return `als-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDb(db: number): string {
  return Number.isFinite(db) ? `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB` : "—";
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ProjectOrganizerScreen() {
  const [projects, setProjects] = useState<OrganizerProject[]>(loadProjects);
  const [selectedId, setSelectedId] = useState<string | null>(() => loadProjects()[0]?.id ?? null);
  const [activeExportId, setActiveExportId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Session-only object URLs for the attached bounces, keyed by export id.
  const urls = useRef<Map<string, string>>(new Map());
  const rafRef = useRef<number | null>(null);

  const ordered = useMemo(
    () => [...projects].sort((a, b) => b.updated_at_ms - a.updated_at_ms),
    [projects],
  );
  const selected = ordered.find((p) => p.id === selectedId) ?? ordered[0] ?? null;

  useEffect(() => {
    persistProjects(projects);
  }, [projects]);

  // Revoke every object URL on unmount so we don't leak the session's audio.
  useEffect(() => {
    const map = urls.current;
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    if (dur > 0) setProgress(Math.min(1, audio.currentTime / dur));
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const mutateProject = useCallback(
    (id: string, patch: (p: OrganizerProject) => OrganizerProject) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...patch(p), updated_at_ms: Date.now() } : p)),
      );
    },
    [],
  );

  function handleNewProject() {
    const now = Date.now();
    const project: OrganizerProject = {
      id: `org-${now}`,
      name: "",
      alsFiles: [],
      exports: [],
      created_at_ms: now,
      updated_at_ms: now,
    };
    setProjects((prev) => [project, ...prev]);
    setSelectedId(project.id);
  }

  function handleRename(name: string) {
    if (!selected) return;
    mutateProject(selected.id, (p) => ({ ...p, name }));
  }

  function handleDeleteProject(project: OrganizerProject) {
    const label = project.name.trim() || "Untitled project";
    if (!window.confirm(`Delete "${label}" and its exports? This can't be undone.`)) return;
    for (const exp of project.exports) {
      const url = urls.current.get(exp.id);
      if (url) {
        URL.revokeObjectURL(url);
        urls.current.delete(exp.id);
      }
    }
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    if (selectedId === project.id) setSelectedId(null);
  }

  async function handleAddAls() {
    if (!selected) return;
    setError(null);
    try {
      const picked = await open({
        multiple: true,
        title: "Add Ableton sets to this project",
        filters: [{ name: "Ableton Live Set", extensions: ["als"] }],
      });
      if (picked == null) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;
      const additions: AlsFile[] = paths.map((path) => ({
        id: makeAlsId(),
        path,
        name: basename(path),
      }));
      mutateProject(selected.id, (p) => ({ ...p, alsFiles: [...p.alsFiles, ...additions] }));
    } catch (err) {
      setError(String(err));
    }
  }

  function handleRemoveAls(alsId: string) {
    if (!selected) return;
    mutateProject(selected.id, (p) => ({
      ...p,
      alsFiles: p.alsFiles.filter((f) => f.id !== alsId),
    }));
  }

  async function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // allow re-adding the same file(s)
    if (files.length === 0 || !selected) return;
    setError(null);

    const analyzed: ExportBounce[] = [];
    const failures: string[] = [];
    // Sequential, so a marathon batch of large bounces doesn't decode all at
    // once. One bad file is reported, not fatal to the rest.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setAnalyzing(files.length > 1 ? `${file.name} (${i + 1} of ${files.length})` : file.name);
      try {
        const analysis = await analyzeAudioFile(file);
        const now = Date.now();
        const bounce: ExportBounce = {
          id: makeExportId(i),
          fileName: file.name,
          fileSizeBytes: file.size,
          durationSec: analysis.durationSec,
          sampleRate: analysis.sampleRate,
          channelCount: analysis.channelCount,
          peaks: analysis.peaks,
          integratedLufs: analysis.integratedLufs,
          dynamicRangeLu: analysis.dynamicRangeLu,
          peakDb: analysis.peakDb,
          added_at_ms: now,
        };
        urls.current.set(bounce.id, URL.createObjectURL(file));
        analyzed.push(bounce);
      } catch {
        failures.push(file.name);
      }
    }

    if (analyzed.length > 0) {
      mutateProject(selected.id, (p) => ({ ...p, exports: [...analyzed, ...p.exports] }));
    }
    setAnalyzing(null);
    if (failures.length > 0) {
      setError(
        `Couldn't read ${failures.length} file${failures.length === 1 ? "" : "s"}: ${failures.join(", ")}`,
      );
    }
  }

  function handleDeleteExport(exp: ExportBounce) {
    if (!selected) return;
    if (activeExportId === exp.id) {
      audioRef.current?.pause();
      stopRaf();
      setIsPlaying(false);
      setActiveExportId(null);
      setProgress(0);
    }
    const url = urls.current.get(exp.id);
    if (url) {
      URL.revokeObjectURL(url);
      urls.current.delete(exp.id);
    }
    mutateProject(selected.id, (p) => ({
      ...p,
      exports: p.exports.filter((e) => e.id !== exp.id),
    }));
  }

  function playExport(exp: ExportBounce) {
    const audio = audioRef.current;
    const url = urls.current.get(exp.id);
    if (!audio || !url) return;
    if (activeExportId !== exp.id) {
      audio.src = url;
      setActiveExportId(exp.id);
      setProgress(0);
    }
    void audio.play();
    setIsPlaying(true);
    stopRaf();
    rafRef.current = requestAnimationFrame(tick);
  }

  function togglePlay(exp: ExportBounce) {
    if (activeExportId === exp.id && isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      stopRaf();
    } else {
      playExport(exp);
    }
  }

  function seekExport(exp: ExportBounce, fraction: number) {
    const audio = audioRef.current;
    const url = urls.current.get(exp.id);
    if (!audio || !url) return;
    if (activeExportId !== exp.id) {
      audio.src = url;
      setActiveExportId(exp.id);
    }
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : exp.durationSec;
    audio.currentTime = fraction * dur;
    setProgress(fraction);
  }

  function handleEnded() {
    setIsPlaying(false);
    setProgress(0);
    stopRaf();
  }

  return (
    <div className="organizer">
      <audio ref={audioRef} preload="none" onEnded={handleEnded} hidden />
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={handleFilePicked}
      />

      <aside className="organizer__list" aria-label="Projects">
        <div className="organizer__list-head">
          <span className="eyebrow">Organizer</span>
          <button type="button" className="px-btn px-btn--primary" onClick={handleNewProject}>
            New project
          </button>
        </div>

        {ordered.length === 0 ? (
          <p className="organizer__list-empty">
            Lay out a release — the Ableton sets that make it up and the bounces you exported.
            An EP is several songs in one project.
          </p>
        ) : (
          <div className="organizer__items">
            {ordered.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`organizer__item ${selected?.id === project.id ? "is-selected" : ""}`}
                onClick={() => setSelectedId(project.id)}
              >
                <span className="organizer__item-title">
                  {project.name.trim() || "Untitled project"}
                </span>
                <span className="organizer__item-meta">
                  {project.exports.length === 0
                    ? "No exports"
                    : `${project.exports.length} export${project.exports.length === 1 ? "" : "s"}`}
                  {project.alsFiles.length > 0
                    ? ` · ${project.alsFiles.length} set${project.alsFiles.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {selected ? (
        <section className="organizer__detail" aria-label="Project">
          <div className="organizer__detail-bar">
            <input
              className="organizer__name"
              value={selected.name}
              placeholder="Untitled project"
              aria-label="Project name"
              onChange={(event) => handleRename(event.target.value)}
            />
            <button
              type="button"
              className="px-btn px-btn--danger"
              onClick={() => handleDeleteProject(selected)}
            >
              Delete
            </button>
          </div>

          {error && <p className="organizer__error">{error}</p>}

          <div className="organizer__als">
            <div className="organizer__als-head">
              <span className="organizer__field-label">Ableton projects</span>
              <button type="button" className="px-btn" onClick={() => void handleAddAls()}>
                Add .als…
              </button>
            </div>
            {selected.alsFiles.length === 0 ? (
              <span className="organizer__als-none">No sets linked yet</span>
            ) : (
              <ul className="organizer__als-list">
                {selected.alsFiles.map((file) => (
                  <li key={file.id} className="organizer__als-item">
                    <span className="organizer__als-name" title={file.path}>
                      {file.name}
                    </span>
                    <button
                      type="button"
                      className="px-btn px-btn--danger"
                      onClick={() => handleRemoveAls(file.id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="organizer__exports-head">
            <span className="organizer__field-label">Exports</span>
            <button
              type="button"
              className="px-btn px-btn--primary"
              disabled={analyzing !== null}
              onClick={() => fileInputRef.current?.click()}
            >
              {analyzing ? "Reading…" : "Add exports…"}
            </button>
          </div>

          {analyzing && (
            <p className="organizer__analyzing">Measuring loudness of {analyzing}…</p>
          )}

          {selected.exports.length === 0 && !analyzing ? (
            <div className="organizer__exports-empty">
              <strong>No bounces yet.</strong>
              <p>
                Add a rendered mixdown (WAV, AIFF, MP3, FLAC) and Recall shows its waveform,
                integrated loudness, and peak — like a file in a mix-review.
              </p>
            </div>
          ) : (
            <div className="organizer__exports">
              {selected.exports.map((exp) => {
                const playable = urls.current.has(exp.id);
                const active = activeExportId === exp.id;
                return (
                  <article key={exp.id} className="organizer__bounce">
                    <div className="organizer__bounce-head">
                      <span className="organizer__bounce-name">{exp.fileName}</span>
                      <div className="organizer__bounce-actions">
                        <span className="organizer__bounce-added">
                          {formatDate(exp.added_at_ms)}
                        </span>
                        <button
                          type="button"
                          className="px-btn px-btn--danger"
                          onClick={() => handleDeleteExport(exp)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="organizer__player">
                      <button
                        type="button"
                        className="organizer__play"
                        disabled={!playable}
                        aria-label={active && isPlaying ? "Pause" : "Play"}
                        title={playable ? undefined : "Re-add this file to play it again"}
                        onClick={() => togglePlay(exp)}
                      >
                        {active && isPlaying ? "❚❚" : "►"}
                      </button>
                      <Waveform
                        peaks={exp.peaks}
                        progress={active ? progress : 0}
                        onSeek={playable ? (f) => seekExport(exp, f) : undefined}
                      />
                    </div>

                    <dl className="organizer__stats">
                      <div className="organizer__stat">
                        <dt>Length</dt>
                        <dd>{formatDuration(exp.durationSec)}</dd>
                      </div>
                      <div className="organizer__stat">
                        <dt>Loudness</dt>
                        <dd>{formatLufs(exp.integratedLufs)}</dd>
                      </div>
                      <div className="organizer__stat">
                        <dt>Dynamics</dt>
                        {exp.dynamicRangeLu == null ? (
                          <dd
                            className="organizer__stat-empty"
                            title="Bounce is under ~3s — too short to measure loudness range."
                          >
                            Not long enough
                          </dd>
                        ) : (
                          <dd>{formatLra(exp.dynamicRangeLu)}</dd>
                        )}
                      </div>
                      <div className="organizer__stat">
                        <dt>Peak</dt>
                        <dd>{formatDb(exp.peakDb)}</dd>
                      </div>
                      <div className="organizer__stat">
                        <dt>Format</dt>
                        <dd>
                          {Math.round(exp.sampleRate / 100) / 10} kHz ·{" "}
                          {exp.channelCount === 1 ? "mono" : exp.channelCount === 2 ? "stereo" : `${exp.channelCount}ch`}
                        </dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : (
        <section className="organizer__detail organizer__detail--empty">
          <div className="organizer__blank">
            <strong>Nothing laid out yet.</strong>
            <p>Create a project, link its Ableton set, and drop in the bounces you exported.</p>
            <button type="button" className="px-btn px-btn--primary" onClick={handleNewProject}>
              New project
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
