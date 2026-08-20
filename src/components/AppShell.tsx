import type { ReactNode } from "react";
import { RecallMark } from "./RecallMark";

// The milestone surfaces: project management, a project's version memory, a recap
// for the selected capture, the timeline workspace, the release organizer, the
// producer notebook, and the producer reference. "versions" is a drill-in under
// Projects, so it shares the Projects nav item.
export type AppSurface =
  | "projects"
  | "briefing"
  | "versions"
  | "recap"
  | "timeline"
  | "organizer"
  | "planner"
  | "notes"
  | "glossary";

type NavItem = {
  id: AppSurface;
  label: string;
  hint: string;
  shortcut: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: "projects", label: "Projects", hint: "Songs & versions", shortcut: "Alt+1" },
  { id: "recap", label: "Report", hint: "What happened, step by step", shortcut: "Alt+2" },
  { id: "timeline", label: "Timeline", hint: "Workspace", shortcut: "Alt+3" },
  { id: "organizer", label: "Organizer", hint: "Mixes & releases", shortcut: "Alt+4" },
  { id: "planner", label: "Planner", hint: "Calendar & tasks", shortcut: "Alt+5" },
  { id: "notes", label: "Notes", hint: "Producer notebook", shortcut: "Alt+6" },
  { id: "glossary", label: "Reference", hint: "Sound terms", shortcut: "Alt+7" },
];

type AppShellProps = {
  surface: AppSurface;
  onChangeSurface: (surface: AppSurface) => void;
  connected: boolean;
  projects: ReactNode;
  briefing: ReactNode;
  versions: ReactNode;
  recap: ReactNode;
  timeline: ReactNode;
  organizer: ReactNode;
  planner: ReactNode;
  notes: ReactNode;
  glossary: ReactNode;
  onOpenStartup: () => void;
  onOpenReport: () => void;
  onOpenSettings: () => void;
};

export function AppShell({
  surface,
  onChangeSurface,
  connected,
  projects,
  briefing,
  versions,
  recap,
  timeline,
  organizer,
  planner,
  notes,
  glossary,
  onOpenStartup,
  onOpenReport,
  onOpenSettings,
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
          <button
            type="button"
            className="recall-sidebar__brand"
            onClick={onOpenStartup}
            aria-label="Return to startup screen"
            title="Return to startup screen"
          >
            <RecallMark size="sm" />
            <span>
              <span>Studio</span>
              <strong>Recall</strong>
            </span>
          </button>

          <div className="recall-sidebar__nav">
            {NAV_ITEMS.map((item) => {
              const active =
                surface === item.id ||
                (item.id === "projects" && (surface === "versions" || surface === "briefing"));
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`recall-sidebar__item ${active ? "is-active" : ""}`}
                  onClick={() => onChangeSurface(item.id)}
                  aria-current={active ? "page" : undefined}
                  aria-keyshortcuts={item.shortcut}
                  title={`${item.label} · ${item.shortcut}`}
                >
                  <span className="recall-sidebar__item-label">{item.label}</span>
                  <span className="recall-sidebar__item-hint">{item.hint}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="recall-sidebar__utility"
            onClick={onOpenSettings}
            aria-keyshortcuts="Control+,"
            title="Settings · Ctrl+,"
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>

          {/* Always reachable: when something breaks, the way to report it must
              not be buried inside the screen that broke. */}
          <button type="button" className="recall-sidebar__report" onClick={onOpenReport}>
            Report a problem
          </button>

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
          {/* Every surface except the Organizer swaps with the keyed transition,
              mounting on entry and unmounting on exit as before. */}
          {surface !== "organizer" && (
            <div
              key={surface}
              className={`recall-surface-stage recall-surface-stage--${surface}`}
              data-surface={surface}
            >
              {surface === "projects" ? (
                <div className="home-surface">{projects}</div>
              ) : surface === "briefing" ? (
                <div className="home-surface">{briefing}</div>
              ) : surface === "versions" ? (
                <div className="home-surface">{versions}</div>
              ) : surface === "recap" ? (
                <div className="home-surface">{recap}</div>
              ) : surface === "planner" ? (
                <div className="home-surface">{planner}</div>
              ) : surface === "notes" ? (
                <div className="home-surface">{notes}</div>
              ) : surface === "glossary" ? (
                <div className="document-surface">{glossary}</div>
              ) : (
                <div className="schema-surface">{timeline}</div>
              )}
            </div>
          )}

          {/* The Organizer stays mounted across tab changes so its audio keeps
              playing when you navigate away — only its visibility toggles. */}
          <div
            key="persistent-organizer"
            className="recall-surface-stage recall-surface-stage--organizer"
            data-surface="organizer"
            hidden={surface !== "organizer"}
            style={surface === "organizer" ? undefined : { display: "none" }}
          >
            <div className="home-surface">{organizer}</div>
          </div>
        </div>
      </div>
    </main>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M6.4 2.2h3.2l.4 1.4c.4.2.7.4 1 .6l1.4-.3 1.6 2.7-1 1c.1.4.1.8 0 1.2l1 1-1.6 2.7-1.4-.3c-.3.2-.6.4-1 .6l-.4 1.4H6.4L6 12.4c-.4-.2-.7-.4-1-.6l-1.4.3L2 9.4l1-1a4.8 4.8 0 010-1.2l-1-1 1.6-2.7 1.4.3c.3-.2.6-.4 1-.6l.4-1.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}
