type LoadingSpinnerProps = {
  className?: string;
};

/** Decorative motion for work that is actively in progress. Parent status copy
 * provides the accessible announcement; the spinner only makes that work felt. */
export function LoadingSpinner({ className = "" }: LoadingSpinnerProps) {
  return <span className={`px-loading-spinner${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
