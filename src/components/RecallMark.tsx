type RecallMarkProps = {
  size?: "sm" | "md";
};

export function RecallMark({ size = "md" }: RecallMarkProps) {
  return (
    <div className={`recall-mark recall-mark--${size}`} aria-hidden="true">
      <span className="recall-mark__core">R</span>
      <span className="recall-mark__trace recall-mark__trace--a" />
      <span className="recall-mark__trace recall-mark__trace--b" />
      <span className="recall-mark__node recall-mark__node--a" />
      <span className="recall-mark__node recall-mark__node--b" />
    </div>
  );
}
