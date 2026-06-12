import { type FormEvent } from "react";
import { RecallMark } from "../../components/RecallMark";

type StartupScreenProps = {
  producerName: string;
  connected: boolean;
  loading: boolean;
  projectCount: number;
  takeCount: number;
  momentCount: number;
  recordingCount: number;
  activeAbletonName: string | null;
  onProducerNameChange: (name: string) => void;
  onEnter: () => void;
};

export function StartupScreen({
  producerName,
  connected,
  loading,
  projectCount,
  takeCount,
  momentCount,
  recordingCount,
  activeAbletonName,
  onProducerNameChange,
  onEnter,
}: StartupScreenProps) {
  const trimmedName = producerName.trim();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onEnter();
  }

  return (
    <main className="startup-screen">
      <div className="startup-screen__shell">
        <section className="startup-hero" aria-label="Recall Studio welcome">
          <div className="startup-hero__brand">
            <RecallMark />
            <div>
              <span className="eyebrow">Recall Studio</span>
              <strong>Session memory for Ableton</strong>
            </div>
          </div>

          <div className="startup-hero__body">
            <span className="startup-hero__kicker">Project Desk</span>
            <h1>{trimmedName ? `Welcome back, ${trimmedName}.` : "Welcome back."}</h1>
            <p>Open your project desk, pick up a take, and keep the moves you want to remember.</p>
          </div>

          <div className="startup-meter" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </section>

        <div className="startup-side">
          <form className="startup-login" onSubmit={handleSubmit}>
            <div className="startup-login__header">
              <span className="eyebrow">Studio Login</span>
              <h2>Local studio profile</h2>
              <p>No cloud account yet. This only personalizes Recall on this machine.</p>
            </div>

            <label className="startup-login__field">
              <span>Producer name</span>
              <input
                value={producerName}
                onChange={(event) => onProducerNameChange(event.target.value)}
                placeholder="Your name or alias"
                autoComplete="name"
              />
            </label>

            <button type="submit" className="startup-action">
              Enter Project Desk
            </button>

            <div className={`startup-bridge ${connected ? "is-connected" : ""}`}>
              <span className="startup-bridge__dot" aria-hidden="true" />
              <span>
                {connected
                  ? activeAbletonName
                    ? `Ableton connected: ${activeAbletonName}`
                    : "Ableton bridge connected"
                  : "Ableton bridge waiting"}
              </span>
            </div>
          </form>

          <aside className="startup-snapshot" aria-label="Studio snapshot">
            <div>
              <span className="eyebrow">Today</span>
              <h2>{loading ? "Opening your library" : "Studio ready"}</h2>
            </div>

            <div className="startup-snapshot__stats">
              <span>
                <strong>{projectCount}</strong>
                projects
              </span>
              <span>
                <strong>{takeCount}</strong>
                takes
              </span>
              <span>
                <strong>{momentCount}</strong>
                moments
              </span>
              <span>
                <strong>{recordingCount}</strong>
                recording
              </span>
            </div>

            <div className="startup-snapshot__flow">
              <span>Project Desk</span>
              <span>Recap</span>
              <span>Timeline</span>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
