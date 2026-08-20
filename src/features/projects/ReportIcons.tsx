import type { ProducerWorkKind } from "../../components/schema/timeline/producerWork";

export type ReportGlyph =
  | "overview"
  | "path"
  | "tracks"
  | "decisions"
  | "graphs"
  | "compare"
  | "time"
  | "actions"
  | "moment"
  | "passages"
  | "evidence"
  | "device"
  | "focus"
  | "iterate"
  | "carry"
  | "trend";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.7,
};

export function ProducerWorkIcon({ kind }: { kind: ProducerWorkKind }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {kind === "writing" && <><path {...stroke} d="M9 18V5l10-2v13" /><circle {...stroke} cx="6" cy="18" r="3" /><circle {...stroke} cx="16" cy="16" r="3" /></>}
      {kind === "recording" && <><rect {...stroke} x="8" y="3" width="8" height="12" rx="4" /><path {...stroke} d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></>}
      {kind === "sound" && <path {...stroke} d="M3 12h2l2-7 3 14 3-12 2 9 2-4h4" />}
      {kind === "arrangement" && <><rect {...stroke} x="3" y="4" width="7" height="6" rx="1" /><rect {...stroke} x="12" y="4" width="9" height="6" rx="1" /><rect {...stroke} x="3" y="14" width="11" height="6" rx="1" /><rect {...stroke} x="16" y="14" width="5" height="6" rx="1" /></>}
      {kind === "mixing" && <><path {...stroke} d="M5 4v16M12 4v16M19 4v16" /><circle {...stroke} cx="5" cy="9" r="2" /><circle {...stroke} cx="12" cy="15" r="2" /><circle {...stroke} cx="19" cy="7" r="2" /></>}
      {kind === "project" && <><path {...stroke} d="M3 7h7l2 2h9v10H3z" /><path {...stroke} d="M3 7V5h7l2 2" /></>}
      {kind === "moment" && <path {...stroke} d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />}
    </svg>
  );
}

export function ReportIcon({ name }: { name: ReportGlyph }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {name === "overview" && <><rect {...stroke} x="3" y="3" width="7" height="7" rx="1" /><rect {...stroke} x="14" y="3" width="7" height="7" rx="1" /><rect {...stroke} x="3" y="14" width="7" height="7" rx="1" /><rect {...stroke} x="14" y="14" width="7" height="7" rx="1" /></>}
      {name === "path" && <><path {...stroke} d="M5 4v4c0 2 2 3 4 3h6c2 0 4 1 4 3v6" /><circle {...stroke} cx="5" cy="4" r="2" /><circle {...stroke} cx="19" cy="20" r="2" /></>}
      {name === "tracks" && <path {...stroke} d="M4 5v14M4 7h12M4 12h16M4 17h9" />}
      {name === "decisions" && <><path {...stroke} d="m5 12 4 4L19 6" /><circle {...stroke} cx="12" cy="12" r="9" /></>}
      {name === "graphs" && <path {...stroke} d="M3 17h3l3-9 4 7 3-5 5 7" />}
      {name === "compare" && <><path {...stroke} d="M4 7h14m0 0-3-3m3 3-3 3M20 17H6m0 0 3-3m-3 3 3 3" /></>}
      {name === "time" && <><circle {...stroke} cx="12" cy="12" r="9" /><path {...stroke} d="M12 7v6l4 2" /></>}
      {name === "actions" && <><path {...stroke} d="m13 2-2 8h6l-7 12 2-9H6z" /></>}
      {name === "moment" && <path {...stroke} d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />}
      {name === "passages" && <><rect {...stroke} x="3" y="5" width="5" height="14" rx="1" /><rect {...stroke} x="10" y="8" width="5" height="11" rx="1" /><rect {...stroke} x="17" y="3" width="4" height="16" rx="1" /></>}
      {name === "evidence" && <><path {...stroke} d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5" /></>}
      {name === "device" && <><rect {...stroke} x="3" y="5" width="18" height="14" rx="2" /><circle {...stroke} cx="8" cy="12" r="2" /><path {...stroke} d="M13 9h5M13 13h5M13 16h3" /></>}
      {name === "focus" && <><circle {...stroke} cx="12" cy="12" r="4" /><path {...stroke} d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></>}
      {name === "iterate" && <><path {...stroke} d="M20 8a8 8 0 0 0-14-3L3 8m1-4v4h4M4 16a8 8 0 0 0 14 3l3-3m-1 4v-4h-4" /></>}
      {name === "carry" && <><path {...stroke} d="M5 4h11l3 3v13H5zM9 4v6h6V4M9 16h6" /></>}
      {name === "trend" && <><path {...stroke} d="m4 17 6-6 4 4 6-8M15 7h5v5" /></>}
    </svg>
  );
}
