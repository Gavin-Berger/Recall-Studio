// The one loading state for "Recall is reading captured work".
//
// It lives in its own module rather than inside SessionRecapScreen because the
// Timeline's version detail reads the same data through the same loader and was
// showing a bare sentence instead — two surfaces telling the producer the same
// thing in two different visual languages. Importing it from the Report module
// would have pulled the whole report screen into the Timeline's chunk to get one
// element, so the element moved out instead.
//
// The stylesheet comes with it: `.report-loading` is defined in
// SessionRecapScreen.css and this is imported by both screens, so whichever one
// mounts first brings the rules.

import { LoadingSpinner } from "../../components/LoadingSpinner";
import "./SessionRecapScreen.css";

export function ReportLoading({
  compact = false,
  label,
}: {
  compact?: boolean;
  /** Overrides the accessible name when the surface is not the Report itself. */
  label?: string;
}) {
  return (
    <section
      className={`report-loading ${compact ? "is-compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={label ?? (compact ? "Loading report detail" : "Building session report")}
    >
      <span className="report-loading__status-line">
        <LoadingSpinner className="report-loading__spinner" />
      </span>
    </section>
  );
}
