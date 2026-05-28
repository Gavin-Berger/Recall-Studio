import { useState } from "react";
import type { ReactNode } from "react";
import { RecallMark } from "./RecallMark";

type EcosystemZone = "memory" | "sessions" | "document" | "signal";

type AppShellProps = {
  rail: ReactNode;
  timeline: ReactNode;
  document: ReactNode;
  inspector: ReactNode;
  statusStrip: ReactNode;
};

export function AppShell({
  rail,
  timeline,
  document,
  inspector,
  statusStrip,
}: AppShellProps) {
  const [activeZone, setActiveZone] = useState<EcosystemZone>("memory");
  function handleSelectZone(zone: EcosystemZone) {
    setActiveZone(zone);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  return (
    <main className={`recall-app recall-app--${activeZone}`}>
      <div className="ecosystem-background" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <nav className="ecosystem-nav" aria-label="Recall Studio sections">
        <div className="ecosystem-nav__brand">
          <RecallMark size="sm" />
          <span>
            <span>Recall Studio</span>
            <strong>Creative Telemetry Ecosystem</strong>
          </span>
        </div>

        <button
          type="button"
          className={activeZone === "memory" ? "is-active" : ""}
          onClick={() => handleSelectZone("memory")}
        >
          Memory
        </button>
        <button
          type="button"
          className={activeZone === "sessions" ? "is-active" : ""}
          onClick={() => handleSelectZone("sessions")}
        >
          Sessions
        </button>
        <button
          type="button"
          className={activeZone === "document" ? "is-active" : ""}
          onClick={() => handleSelectZone("document")}
        >
          Document
        </button>
        <button
          type="button"
          className={activeZone === "signal" ? "is-active" : ""}
          onClick={() => handleSelectZone("signal")}
        >
          Signal
        </button>
      </nav>

      <section
        className={`studio-layout studio-layout--${activeZone}`}
        aria-label="Recall Studio session memory console"
      >
        <div className="ecosystem-pane ecosystem-pane--sessions">{rail}</div>

        <div className="memory-workbench">
          {activeZone === "document" ? document : timeline}
          {statusStrip}
        </div>

        <div className="ecosystem-pane ecosystem-pane--signal">{inspector}</div>
      </section>
    </main>
  );
}
