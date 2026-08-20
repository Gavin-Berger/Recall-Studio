import { useEffect, useMemo, useState } from "react";
import type { TrackObj } from "../../../types/schema";
import { formatClock } from "./format";
import {
  buildBuildSteps,
  buildRecipe,
  buildReconstructionEvents,
  type ReconstructionEvent,
} from "./reconstructionModel";
import type { Activity } from "./types";
import type { CapturedEvidence } from "./captureEvidence";

type MemoryView = "map" | "history";
const INITIAL_STEP_LIMIT = 4;

const CATEGORY_LABEL: Record<ReconstructionEvent["category"], string> = {
  part: "Part",
  automation: "Automation",
  sound: "Sound",
  mix: "Mix",
  note: "Note",
  song: "Song",
  recording: "Recording",
  structure: "Arrangement",
  performance: "Performance",
  project: "Version",
};

const formatBeat = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

function AutomationCurve({ evidence }: { evidence: CapturedEvidence }) {
  const points = evidence.automationPoints;
  if (points.length === 0) return null;
  const minBeat = Math.min(...points.map((point) => point.beat));
  const maxBeat = Math.max(...points.map((point) => point.beat), minBeat + 1);
  const minValue = Math.min(...points.map((point) => point.value));
  const maxValue = Math.max(...points.map((point) => point.value), minValue + 1);
  const coords = points.map((point) => {
    const x = 4 + ((point.beat - minBeat) / (maxBeat - minBeat)) * 212;
    const y = 50 - ((point.value - minValue) / (maxValue - minValue)) * 42;
    return `${x},${y}`;
  }).join(" ");
  return (
    <div className="tl-evidence-curve">
      <span>Automation envelope</span>
      <svg viewBox="0 0 220 58" role="img" aria-label={`${points.length} captured automation points`}>
        <line x1="4" y1="50" x2="216" y2="50" />
        <polyline points={coords} />
        {points.map((point, index) => {
          const [x, y] = coords.split(" ")[index].split(",");
          return <circle key={`${point.beat}-${index}`} cx={x} cy={y} r="2.2" />;
        })}
      </svg>
      <small>Beat {formatBeat(minBeat)}–{formatBeat(maxBeat)}</small>
    </div>
  );
}

function MidiPattern({ evidence }: { evidence: CapturedEvidence }) {
  const notes = evidence.midiNotes;
  if (notes.length === 0) return null;
  const minStart = Math.min(...notes.map((note) => note.startBeats));
  const maxEnd = Math.max(...notes.map((note) => note.startBeats + note.durationBeats), minStart + 1);
  const minPitch = Math.min(...notes.map((note) => note.pitch));
  const maxPitch = Math.max(...notes.map((note) => note.pitch), minPitch + 1);
  return (
    <div className="tl-evidence-pattern">
      <span>MIDI pattern</span>
      <svg viewBox="0 0 220 66" role="img" aria-label={`${notes.length} captured MIDI notes`}>
        {notes.map((note, index) => {
          const x = 4 + ((note.startBeats - minStart) / (maxEnd - minStart)) * 212;
          const width = Math.max(2, (note.durationBeats / (maxEnd - minStart)) * 212);
          const y = 55 - ((note.pitch - minPitch) / (maxPitch - minPitch)) * 46;
          const opacity = note.muted ? 0.25 : 0.48 + ((note.velocity ?? 80) / 127) * 0.42;
          return <rect key={`${note.startBeats}-${note.pitch}-${index}`} x={x} y={y} width={width} height="5" rx="1.5" opacity={opacity} />;
        })}
      </svg>
      <small>{notes.length} notes · {formatBeat(minStart)}–{formatBeat(maxEnd)} beats</small>
    </div>
  );
}

function WarpMap({ evidence }: { evidence: CapturedEvidence }) {
  const markers = evidence.warpMarkers;
  if (markers.length === 0) return null;
  const minBeat = Math.min(...markers.map((marker) => marker.beat));
  const maxBeat = Math.max(...markers.map((marker) => marker.beat), minBeat + 1);
  return (
    <div className="tl-evidence-warp">
      <span>Warp map</span>
      <div>{markers.map((marker, index) => (
        <i key={`${marker.beat}-${index}`} style={{ left: `${((marker.beat - minBeat) / (maxBeat - minBeat)) * 100}%` }} />
      ))}</div>
      <small>{markers.length} markers · Beat {formatBeat(minBeat)}–{formatBeat(maxBeat)}</small>
    </div>
  );
}

function RecreationEvidence({ evidence }: { evidence: CapturedEvidence }) {
  const count = evidence.facts.length + evidence.automationPoints.length + evidence.midiNotes.length + evidence.warpMarkers.length;
  if (count === 0) return null;
  return (
    <details className="tl-recipe__recreation">
      <summary>Recreation data <small>{count}</small></summary>
      {evidence.facts.length > 0 && (
        <dl>
          {evidence.facts.map((fact) => <div key={`${fact.label}-${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
        </dl>
      )}
      <AutomationCurve evidence={evidence} />
      <MidiPattern evidence={evidence} />
      <WarpMap evidence={evidence} />
    </details>
  );
}

export function ReconstructionMemory({
  activities,
  tracks,
  onSelectTrack,
  onSelectActivity,
}: {
  activities: Activity[];
  tracks: TrackObj[];
  onSelectTrack: (trackId: string) => void;
  onSelectActivity?: (activity: Activity) => void;
}) {
  const events = useMemo(() => buildReconstructionEvents(activities, tracks), [activities, tracks]);
  const steps = useMemo(() => buildBuildSteps(events), [events]);
  const placedEvents = useMemo(() => events.filter((event) => event.position), [events]);
  const unplacedCount = events.length - placedEvents.length;
  const [view, setView] = useState<MemoryView>(placedEvents.length > 0 ? "map" : "history");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  const recipe = selectedEvent ? buildRecipe(selectedEvent) : null;
  const visibleSteps = showAllSteps ? steps : steps.slice(0, INITIAL_STEP_LIMIT);
  const mapTracks = tracks.filter((track) => placedEvents.some((event) => event.activity.trackId === track.id));
  const firstBar = placedEvents.length > 0
    ? Math.min(...placedEvents.map((event) => event.position!.bar))
    : 1;
  const lastBar = Math.max(
    ...placedEvents.map((event) => event.endPosition?.bar ?? event.position!.bar),
    firstBar + 8,
  );
  const barSpan = Math.max(1, lastBar - firstBar + 1);
  const markerLeft = (event: ReconstructionEvent) => ((event.position!.bar - firstBar) / barSpan) * 100;
  const markerWidth = (event: ReconstructionEvent) => {
    const endBar = event.endPosition?.bar ?? event.position!.bar;
    return Math.max(0.8, ((endBar - event.position!.bar + 0.35) / barSpan) * 100);
  };

  useEffect(() => {
    setSelectedEventId(null);
    setShowAllSteps(false);
    setView(placedEvents.length > 0 ? "map" : "history");
  }, [activities, placedEvents.length]);

  const selectEvent = (event: ReconstructionEvent) => {
    setSelectedEventId(event.id);
    onSelectTrack(event.activity.trackId);
    onSelectActivity?.(event.activity);
  };

  if (events.length === 0) return null;

  return (
    <section className="tl-reconstruct" aria-label="Build story">
      <header className="tl-reconstruct__head">
        <div className="tl-reconstruct__intro">
          <span>Session story</span>
          <strong>Follow how this pass took shape</strong>
          <p>Move through the song or retrace decisions in order.</p>
        </div>
        <nav className="tl-reconstruct__views" role="tablist" aria-label="Build story view">
          <button
            type="button"
            id="story-position-tab"
            role="tab"
            className={view === "map" ? "is-active" : ""}
            onClick={() => setView("map")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              setView("history");
              requestAnimationFrame(() => document.getElementById("story-sequence-tab")?.focus());
            }}
            disabled={placedEvents.length === 0}
            aria-selected={view === "map"}
            aria-controls="story-position-panel"
            tabIndex={view === "map" ? 0 : -1}
          >
            Song position <small>{placedEvents.length}</small>
          </button>
          <button
            type="button"
            id="story-sequence-tab"
            role="tab"
            className={view === "history" ? "is-active" : ""}
            onClick={() => setView("history")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" || placedEvents.length === 0) return;
              event.preventDefault();
              setView("map");
              requestAnimationFrame(() => document.getElementById("story-position-tab")?.focus());
            }}
            aria-selected={view === "history"}
            aria-controls="story-sequence-panel"
            tabIndex={view === "history" ? 0 : -1}
          >
            Sequence <small>{steps.length}</small>
          </button>
        </nav>
      </header>

      <div className={`tl-reconstruct__workspace ${recipe ? "has-recipe" : ""}`}>
        <div className="tl-reconstruct__primary">
          {view === "map" ? (
            <div
              className="tl-songmap"
              id="story-position-panel"
              role="tabpanel"
              aria-labelledby="story-position-tab"
            >
              <div className="tl-reconstruct__section-head">
                <div><b>Song position</b></div>
                <small>Bars {firstBar}–{lastBar}</small>
              </div>
              <div className="tl-songmap__surface">
                <div className="tl-songmap__ruler" aria-hidden="true">
                  {Array.from({ length: 5 }, (_, index) => {
                    const bar = Math.round(firstBar + (lastBar - firstBar) * (index / 4));
                    return <span key={`${bar}-${index}`} style={{ left: `${index * 25}%` }}>Bar {bar}</span>;
                  })}
                </div>
                {mapTracks.map((track) => (
                  <div className="tl-songmap__lane" key={track.id}>
                    <button type="button" className="tl-songmap__track" onClick={() => onSelectTrack(track.id)}>
                      {track.name || (track.type === "master" ? "Main" : "Untitled track")}
                    </button>
                    <div className="tl-songmap__rail">
                      {placedEvents.filter((event) => event.activity.trackId === track.id).map((event) => (
                        <button
                          type="button"
                          key={event.id}
                          className={`tl-songmap__event is-${event.category} ${selectedEvent?.id === event.id ? "is-selected" : ""}`}
                          style={{ left: `${markerLeft(event)}%`, width: `${markerWidth(event)}%` }}
                          onClick={() => selectEvent(event)}
                          title={`${event.title} · ${event.position?.label}`}
                          aria-label={`${event.title}, ${event.position?.label}`}
                        >
                          <i />
                          <span>{event.title}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {unplacedCount > 0 && (
                <button type="button" className="tl-songmap__more" onClick={() => setView("history")}>
                  {unplacedCount} other captured change{unplacedCount === 1 ? " has" : "s have"} no bar position
                  <span>See the complete sequence →</span>
                </button>
              )}
            </div>
          ) : (
            <div
              className="tl-buildhistory"
              id="story-sequence-panel"
              role="tabpanel"
              aria-labelledby="story-sequence-tab"
            >
              <div className="tl-reconstruct__section-head">
                <div><b>Build sequence</b></div>
                <small>oldest first</small>
              </div>
              <div className="tl-buildhistory__steps">
                {visibleSteps.map((step, index) => {
                  const representative = step.events.at(-1)!;
                  const selected = step.events.some((event) => event.id === selectedEvent?.id);
                  return (
                    <button
                      type="button"
                      key={step.id}
                      className={`tl-buildstep is-${representative.category} ${selected ? "is-selected" : ""}`}
                      onClick={() => selectEvent(representative)}
                    >
                      <span className="tl-buildstep__node">
                        <i aria-hidden="true" />
                        <b>{String(index + 1).padStart(2, "0")}</b>
                      </span>
                      <span className="tl-buildstep__body">
                        <small>{formatClock(step.startMs)}</small>
                        <b>{step.trackName}</b>
                        <span>{step.summary}</span>
                      </span>
                      <span className="tl-buildstep__count" aria-label={`${step.events.length} captured moves`}>
                        <b>{step.events.length}</b>
                        <small>move{step.events.length === 1 ? "" : "s"}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
              {steps.length > INITIAL_STEP_LIMIT && (
                <button type="button" className="tl-buildhistory__more" onClick={() => setShowAllSteps((current) => !current)}>
                  {showAllSteps ? "Show the short sequence" : `Show all ${steps.length} steps`}
                </button>
              )}
            </div>
          )}
        </div>

        {recipe && selectedEvent && (
          <aside className="tl-recipe" aria-live="polite">
            <div className="tl-recipe__head">
              <div><span>Selected move</span><b>What Recall can prove</b></div>
              <button type="button" onClick={() => setSelectedEventId(null)} aria-label="Close selected move">×</button>
            </div>
            <span className={`tl-recipe__kind is-${selectedEvent.category}`}>{CATEGORY_LABEL[selectedEvent.category]}</span>
            <h3>{recipe.what}</h3>
            <dl>
              <div><dt>Track</dt><dd>{recipe.track}</dd></div>
              <div><dt>Where</dt><dd>{recipe.where}</dd></div>
              <div><dt>When</dt><dd>{recipe.when}</dd></div>
              <div><dt>Change</dt><dd>{recipe.change}</dd></div>
            </dl>
            {recipe.context.map((line) => <p className="tl-recipe__context" key={line}>{line}</p>)}
            {selectedEvent.activity.evidence && <RecreationEvidence evidence={selectedEvent.activity.evidence} />}
            <details className="tl-recipe__evidence">
              <summary>Capture evidence</summary>
              <p>{recipe.evidence}</p>
            </details>
            {recipe.missing.length > 0 && (
              <details className="tl-recipe__missing">
                <summary>{recipe.missing.length} detail{recipe.missing.length === 1 ? "" : "s"} not captured</summary>
                {recipe.missing.map((item) => <span key={item}>{item}</span>)}
              </details>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}

export default ReconstructionMemory;
