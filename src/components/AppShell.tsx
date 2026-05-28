import type { ReactNode } from "react";

type AppShellProps = {
  topBar: ReactNode;
  overview: ReactNode;
  timeline: ReactNode;
  connection: ReactNode;
  footer: ReactNode;
};

export function AppShell({
  topBar,
  overview,
  timeline,
  connection,
  footer,
}: AppShellProps) {
  return (
    <main className="recall-app">
      {topBar}

      <section className="cockpit-layout">
        {overview}
        {timeline}
        {connection}
      </section>

      {footer}
    </main>
  );
}
