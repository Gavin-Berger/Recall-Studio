type TelemetryStatProps = {
  label: string;
  value: string | number;
  hint?: string;
};

export function TelemetryStat({ label, value, hint }: TelemetryStatProps) {
  return (
    <div className="telemetry-stat">
      <span className="telemetry-stat__label">{label}</span>
      <strong className="telemetry-stat__value">{value}</strong>
      {hint && <span className="telemetry-stat__hint">{hint}</span>}
    </div>
  );
}
