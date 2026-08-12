import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordError } from "../features/diagnostics/errorLog";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
  copied: boolean;
};

// A last-resort screen for an unexpected render failure. It deliberately keeps
// the recovery path small: restart, copy the exact failure, then use the normal
// Report a problem flow after Recall reopens. A blank window is never useful to
// a beta tester.
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    recordError(
      "Recall",
      "Recall hit an unexpected screen error.",
      `${error.stack ?? `${error.name}: ${error.message}`}\n${errorInfo.componentStack ?? ""}`.trim(),
    );
  }

  private copyDetails = async () => {
    const { error } = this.state;
    if (!error) return;

    const details = [
      "RECALL STUDIO — UNEXPECTED SCREEN ERROR",
      `Time: ${new Date().toISOString()}`,
      `Message: ${error.message}`,
      "",
      error.stack ?? "(No stack trace was available.)",
    ].join("\n");

    try {
      await navigator.clipboard.writeText(details);
      this.setState({ copied: true });
    } catch {
      this.setState({ copied: false });
    }
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="app-error-boundary" role="alert">
        <section className="app-error-boundary__card" aria-labelledby="app-error-boundary-title">
          <p className="app-error-boundary__eyebrow">Recall needs a restart</p>
          <h1 id="app-error-boundary-title">This screen stopped unexpectedly.</h1>
          <p>
            Your saved sessions are still on this computer. Restart Recall, then use “Report a
            problem” if this happens again.
          </p>
          <p className="app-error-boundary__detail">{error.message || "Unknown screen error."}</p>
          <div className="app-error-boundary__actions">
            <button type="button" className="px-btn" onClick={() => void this.copyDetails()}>
              {copied ? "Error details copied" : "Copy error details"}
            </button>
            <button type="button" className="px-btn px-btn--primary" onClick={() => window.location.reload()}>
              Restart Recall
            </button>
          </div>
          {!copied && (
            <p className="app-error-boundary__hint">
              If copying does not work, take a screenshot of this message before restarting.
            </p>
          )}
        </section>
      </main>
    );
  }
}
