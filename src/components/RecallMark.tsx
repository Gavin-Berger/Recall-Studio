type RecallMarkProps = {
  size?: "sm" | "md";
};

export function RecallMark({ size = "md" }: RecallMarkProps) {
  return (
    <div className={`recall-mark recall-mark--${size}`} aria-hidden="true">
      <svg className="recall-mark__glyph" viewBox="0 0 56 56" focusable="false">
        <path className="recall-mark__return-line" d="M13 37h11" />
        <path
          className="recall-mark__return-line"
          d="M30 37h5c6.2 0 10-3.8 10-9.5S41.2 18 35 18H19"
        />
      </svg>
    </div>
  );
}
