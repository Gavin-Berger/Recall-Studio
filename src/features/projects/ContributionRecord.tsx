// The contribution record — "what you did, how, and when", captured live from
// Ableton. Presentational: it takes the already-computed arc, ledger, and
// track-grouped credit/labour split and renders them. The briefing screen wires
// it to a project's real history.
//
// The arc and the "what stuck" tracks are expandable: the summary reads at a
// glance, the detail is there when someone wants it.

import "./ProjectBriefingScreen.css";
import { formatSessionDate } from "../sessionFormat";
import { sittingWork, type Sitting, type StoryLedger, type TrackContribution } from "./songStory";

// Hands-on minutes as "5 hr 4 min" — the labour line's headline figure.
function humanDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

// Wall-clock start of a sitting ("10:48 AM"), local to the reader.
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

type ContributionRecordProps = {
  setName: string | null;
  ledger: StoryLedger;
  sittings: Sitting[];
  survivedTracks: TrackContribution[];
  removedTracks: TrackContribution[];
};

export function ContributionRecord({
  setName,
  ledger,
  sittings,
  survivedTracks,
  removedTracks,
}: ContributionRecordProps) {
  return (
    <section className="brief__section brief__story">
      <div className="brief__kick">
        <h2>What you did here</h2>
        <span>captured live from {setName ?? "Ableton"} · not self-reported</span>
      </div>

      <div className="story-ledger">
        <div>
          <span className="story-ledger__n">{humanDuration(ledger.activeMs)}</span>
          <span className="story-ledger__l">hands-on</span>
        </div>
        <div>
          <span className="story-ledger__n">{ledger.sittings}</span>
          <span className="story-ledger__l">sitting{ledger.sittings === 1 ? "" : "s"}</span>
        </div>
        <div>
          <span className="story-ledger__n">{ledger.moves.toLocaleString()}</span>
          <span className="story-ledger__l">moves</span>
        </div>
        <div>
          <span className="story-ledger__n">{ledger.tracksShaped}</span>
          <span className="story-ledger__l">tracks shaped</span>
        </div>
      </div>

      <ol className="story-arc">
        {sittings.map((sitting) => (
          <li key={sitting.id} className="story-sit">
            <details>
              <summary className="story-sit__sum">
                <span className="disclosure-mark" aria-hidden="true" />
                <span className="story-sit__when">
                  {clock(sitting.startMs)}
                  <small>{formatSessionDate(sitting.startMs)}</small>
                </span>
                <span className="story-sit__body">
                  <span className="story-sit__label">{sitting.label}</span>
                  <span className="story-sit__work">{sittingWork(sitting)}</span>
                </span>
                <span className="story-sit__moves">{plural(sitting.moveCount, "move")}</span>
              </summary>
              <div className="story-sit__detail">
                {sitting.newTracks.length > 0 && (
                  <div className="story-sit__group">
                    <span className="story-sit__dt">brought in</span>
                    <span className="story-sit__dd">{sitting.newTracks.join(", ")}</span>
                  </div>
                )}
                {sitting.reworkedTracks.length > 0 && (
                  <div className="story-sit__group">
                    <span className="story-sit__dt">reworked</span>
                    <span className="story-sit__dd">{sitting.reworkedTracks.join(", ")}</span>
                  </div>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>

      {survivedTracks.length > 0 && (
        <div className="story-recap">
          <h3 className="story-recap__h">What stuck</h3>
          <ul className="story-tracks">
            {survivedTracks.map((track) => (
              <li key={track.trackKey} className="track-row">
                <details>
                  <summary className="track-row__sum">
                    <span className="disclosure-mark" aria-hidden="true" />
                    <span className="track-row__name">{track.trackName}</span>
                    <span className="track-row__meta">
                      {plural(track.changeCount, "change")} · {plural(track.deviceCount, "plugin")}
                    </span>
                  </summary>
                  {track.params.length > 0 && (
                    <ul className="track-row__params">
                      {track.params.map((net) => (
                        <li key={`${net.deviceName}-${net.paramName}`} className="recap-row">
                          <span className="recap-row__where">
                            {net.deviceName ? (
                              <span className="recap-row__dev">{net.deviceName}</span>
                            ) : null}
                            {net.paramName ? (
                              <span className="recap-row__param"> · {net.paramName}</span>
                            ) : null}
                          </span>
                          <span className="recap-row__ba">
                            <span className="ba__from">{net.beforeDisplay}</span>
                            <span className="ba__change" aria-hidden="true" />
                            <span className="sr-only">changed to</span>
                            <span className="ba__to">{net.afterDisplay}</span>
                            {net.count > 1 ? <span className="ba__n">{net.count}×</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {removedTracks.length > 0 && (
        <div className="story-cut">
          <h3 className="story-recap__h">Explored, later cut</h3>
          <p className="story-cut__note">Not in the latest take — counted as time, not credit.</p>
          <ul className="story-cut__list">
            {removedTracks.map((track) => (
              <li key={track.trackKey} className="cut-row">
                <span className="cut-row__name">{track.trackName}</span>
                <span className="cut-row__moves">{plural(track.changeCount, "change")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
