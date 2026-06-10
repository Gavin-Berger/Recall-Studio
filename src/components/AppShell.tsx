import type { ReactNode } from "react";
import { RecallMark } from "./RecallMark";

// The milestone surfaces: the landing page, the schema-driven timeline, and the
// producer glossary. Capture/Analytics/Document were retired in favour of the
// single schema timeline experience.
export type AppSurface = "home" | "timeline" | "glossary";

type NavItem = {
  id: AppSurface;
  label: string;
  hint: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Current Session", hint: "Live overview" },
  { id: "timeline", label: "Timeline", hint: "Schema & moments" },
  { id: "glossary", label: "Cheat Sheet", hint: "Producer glossary" },
];

type AppShellProps = {
  surface: AppSurface;
  onChangeSurface: (surface: AppSurface) => void;
  connected: boolean;
  home: ReactNode;
  timeline: ReactNode;
  glossary: ReactNode;
};

export function AppShell({
  surface,
  onChangeSurface,
  connected,
  home,
  timeline,
  glossary,
}: AppShellProps) {
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
          ) : surface === "glossary" ? (
            <div className="document-surface">{glossary}</div>
          ) : (
            <div className="schema-surface">{timeline}</div>
          )}
        </div>
      </div>
    </main>
  );
}
