type RecallMarkProps = {
  size?: "sm" | "md";
};

export function RecallMark({ size = "md" }: RecallMarkProps) {
  return (
    <div className={`recall-mark recall-mark--${size}`} aria-hidden="true">
      <svg
        className="recall-mark__glyph"
        viewBox="0 0 56 56"
        focusable="false"
      >
        <path className="recall-mark__plate" d="M15 16 L39 11 L45 40 L17 43 Z" />
        <path className="recall-mark__signal" d="M13 35 C20 30 28 41 42 34" />
        <path className="recall-mark__trace recall-mark__trace--a" d="M14 24 L27 18 L40 22" />
        <path className="recall-mark__trace recall-mark__trace--b" d="M18 40 L32 38 L42 36" />
        <circle className="recall-mark__node recall-mark__node--a" cx="40" cy="17" r="3.6" />
        <circle className="recall-mark__node recall-mark__node--b" cx="14" cy="37" r="3.6" />
      </svg>
      <span className="recall-mark__core">R</span>
    </div>
  );
}
