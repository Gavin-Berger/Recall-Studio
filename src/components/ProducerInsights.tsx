import type { RecallTimelineMoment, SessionStats } from "../types/recall";
import { buildSessionInsights } from "../utils/sessionInsights";

type ProducerInsightsProps = {
  events: RecallTimelineMoment[];
  stats: SessionStats;
};

export function ProducerInsights({ events, stats }: ProducerInsightsProps) {
  const insights = buildSessionInsights(events, stats);

  return (
    <section className="producer-insights">
      <div className="section-kicker">Producer Read</div>

      <div className="producer-insights__grid">
        {insights.map((insight) => (
          <article key={insight.label}>
            <span>{insight.label}</span>
            <strong>{insight.value}</strong>
            <p>{insight.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
