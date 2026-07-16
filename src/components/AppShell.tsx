import type { ReactNode } from "react";
import { RecallMark } from "./RecallMark";

// The milestone surfaces: project management, a project's version memory, a recap
// for the selected capture, the timeline workspace, the release organizer, the
// producer notebook, and the producer reference. "versions" is a drill-in under
// Projects, so it shares the Projects nav item.
export type AppSurface =
  | "projects"
  | "versions"
  | "recap"
  | "timeline"
  | "organizer"
  | "notes"
  | "glossary";

type NavItem = {
  id: AppSurface;
  label: string;
  hint: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: "projects", label: "Projects", hint: "Songs & versions" },
  { id: "recap", label: "Recap", hint: "Session summary" },
  { id: "timeline", label: "Timeline", hint: "Workspace" },
  { id: "organizer", label: "Organizer", hint: "Mixes & releases" },
  { id: "notes", label: "Notes", hint: "Producer notebook" },
  { id: "glossary", label: "Reference", hint: "Sound terms" },
];

type AppShellProps = {
  surface: AppSurface;
  onChangeSurface: (surface: AppSurface) => void;
  connected: boolean;
  projects: ReactNode;
  versions: ReactNode;
  recap: ReactNode;
  timeline: ReactNode;
  organizer: ReactNode;
  notes: ReactNode;
  glossary: ReactNode;
};

export function AppShell({
  surface,
  onChangeSurface,
  connected,
  projects,
  versions,
  recap,
  timeline,
  organizer,
  notes,
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
            {NAV_ITEMS.map((item) => {
              const active =
                surface === item.id || (item.id === "projects" && surface === "versions");
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`recall-sidebar__item ${active ? "is-active" : ""}`}
                  onClick={() => onChangeSurface(item.id)}
                >
                  <span className="recall-sidebar__item-label">{item.label}</span>
                  <span className="recall-sidebar__item-hint">{item.hint}</span>
                </button>
              );
            })}
          </div>

          <div
            className={`recall-sidebar__status ${
              connected ? "is-connected" : ""
            }`}
          >
            <span className="recall-sidebar__status-dot" aria-hidden="true" />
            <span>{connected ? "Listening to Ableton" : "Listening for Ableton…"}</span>
          </div>
        </nav>

        <div className="recall-frame__content">
          {surface === "projects" ? (
            <div className="home-surface">{projects}</div>
          ) : surface === "versions" ? (
            <div className="home-surface">{versions}</div>
          ) : surface === "recap" ? (
            <div className="home-surface">{recap}</div>
          ) : surface === "organizer" ? (
            <div className="home-surface">{organizer}</div>
          ) : surface === "notes" ? (
            <div className="home-surface">{notes}</div>
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
