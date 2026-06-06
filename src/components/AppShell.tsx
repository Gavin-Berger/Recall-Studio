import type { ReactNode } from "react";
import { RecallMark } from "./RecallMark";

export type AppSurface =
  | "home"
  | "capture"
  | "timeline"
  | "analytics"
  | "glossary";

type NavItem = {
  id: AppSurface;
  label: string;
  hint: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Current Session", hint: "Live overview" },
  { id: "capture", label: "Capture", hint: "Incoming signal" },
  { id: "timeline", label: "Documentation", hint: "Session document" },
  { id: "analytics", label: "Analytics", hint: "Producer insights" },
  { id: "glossary", label: "Cheat Sheet", hint: "Producer glossary" },
];

type AppShellProps = {
  surface: AppSurface;
  onChangeSurface: (surface: AppSurface) => void;
  connected: boolean;
  home: ReactNode;
  rail: ReactNode;
  timeline: ReactNode;
  document: ReactNode;
  analytics: ReactNode;
  glossary: ReactNode;
  inspector: ReactNode;
  statusStrip: ReactNode;
};

export function AppShell({
  surface,
  onChangeSurface,
  connected,
  home,
  rail,
  timeline,
  document,
  analytics,
  glossary,
  inspector,
  statusStrip,
}: AppShellProps) {
  // Document and analytics are self-contained, full-width views. Only capture
  // is a true three-column workspace (rail + live stage + inspector).
  return (
    <main className={`recall-app recall-app--${surface}`}>
      <div className="ecosystem-background" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className="recall-frame">
        <nav className="recall-sidebar" aria-label="Recall Studio navigation">
          <div className="recall-sidebar__brand">
            <RecallMark size="sm" />
            <span>
              <span>Studio</span>
              <strong>Recall</strong>
            </span>
          </div>

          <div className="recall-sidebar__nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`recall-sidebar__item ${
                  surface === item.id ? "is-active" : ""
                }`}
                onClick={() => onChangeSurface(item.id)}
              >
                <span className="recall-sidebar__item-label">{item.label}</span>
                <span className="recall-sidebar__item-hint">{item.hint}</span>
              </button>
            ))}
          </div>

          <div
            className={`recall-sidebar__status ${
              connected ? "is-connected" : ""
            }`}
          >
            <span className="recall-sidebar__status-dot" aria-hidden="true" />
            <span>{connected ? "Live bridge connected" : "Awaiting bridge"}</span>
          </div>
        </nav>

        <div className="recall-frame__content">
          {surface === "home" ? (
            <div className="home-surface">{home}</div>
          ) : surface === "timeline" ? (
            <div className="document-surface">{document}</div>
          ) : surface === "analytics" ? (
            <div className="document-surface">{analytics}</div>
          ) : surface === "glossary" ? (
            <div className="document-surface">{glossary}</div>
          ) : (
            <section
              className={`studio-layout studio-layout--${surface}`}
              aria-label="Recall Studio workspace"
            >
              <div className="ecosystem-pane ecosystem-pane--rail">{rail}</div>

              <div className="memory-workbench">
                {timeline}
                {statusStrip}
              </div>

              <div className="ecosystem-pane ecosystem-pane--inspector">
                {inspector}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
