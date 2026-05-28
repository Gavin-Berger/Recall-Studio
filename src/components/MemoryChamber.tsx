import type { CSSProperties } from "react";
import type { RecallTimelineMoment } from "../types/recall";

type MemoryChamberProps = {
  events: RecallTimelineMoment[];
};

export function MemoryChamber({ events }: MemoryChamberProps) {
  const constellationNodes = buildConstellationNodes(events);

  return (
    <div className="memory-space" aria-label="Session memory space">
      <div className="memory-space__grid" />
      <div className="memory-space__horizon" />
      <div className="memory-space__playhead" />

      <div className="memory-space__constellation">
        {constellationNodes.map((node) => (
          <span
            className={`memory-node memory-node--${node.type}`}
            key={node.id}
            style={
              {
                "--node-x": `${node.x}%`,
                "--node-y": `${node.y}%`,
                "--node-delay": `${node.delay}ms`,
              } as CSSProperties
            }
          >
            <i />
          </span>
        ))}
      </div>

      <div className="memory-space__readout">
        <span>Spatial Recall</span>
        <strong>{events.length || "No"} captured moments</strong>
      </div>
    </div>
  );
}

function buildConstellationNodes(events: RecallTimelineMoment[]) {
  const fallbackTypes: RecallTimelineMoment["type"][] = [
    "track",
    "device",
    "parameter",
    "clip",
    "transport",
    "tempo",
  ];
  const source = events.length > 0 ? events.slice(-24) : fallbackTypes;

  return source.map((item, index) => {
    const type = typeof item === "string" ? item : item.type;
    const lane = index % 6;

    return {
      id: typeof item === "string" ? `${item}-${index}` : item.id,
      type,
      x: 8 + ((index * 17) % 84),
      y: 18 + lane * 10 + ((index * 7) % 9),
      delay: index * 120,
    };
  });
}
