import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { describeWayBack, type WayBack } from "./wayBack";

// Where this work lives, and whether going there will show you it.
//
// The Timeline pointed everywhere except back at the music. Every action on it
// led further into Recall — the Report, the workspace, the breakdown — and the
// one question a producer opening this after two weeks actually has is *how do
// I get back to that?*
//
// Recall can answer half of it honestly. It knows the file. It does not hold
// the file's contents, so it cannot put the set back the way it was that night.
// The panel says exactly that, and says whether the file has been worked since,
// because a producer cannot know that on their own and getting it wrong costs
// them a real trip into Ableton for nothing.

type WayBackPanelProps = {
  way: WayBack;
};

export function WayBackPanel({ way }: WayBackPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  if (!way.path) {
    return (
      <p className="ph-back__quiet">{describeWayBack(way)}</p>
    );
  }

  async function reveal() {
    setError(null);
    // In a plain browser there is no file system to show. Saying so beats a
    // button that silently does nothing.
    if (!isTauri()) {
      setError("Opening a folder only works in the Recall app, not in a browser.");
      return;
    }
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(way.path!);
      setRevealed(true);
    } catch {
      setError("Couldn't open that folder. The set may have been moved or renamed.");
    }
  }

  return (
    <section className="ph-back" aria-label="Where this work lives">
      <h3 className="ph-contents__head">Getting back to it</h3>

      <p className="ph-back__line">{describeWayBack(way)}</p>

      <p className="ph-back__file">
        <span className="ph-back__name">{way.fileName}</span>
        {/* The folder, quiet and full-width — a producer looking for this by
            hand needs the whole path, not a truncated hint. */}
        <span className="ph-back__path">{way.path}</span>
      </p>

      <div className="ph-back__actions">
        <button type="button" className="px-btn" onClick={() => void reveal()}>
          Show in folder
        </button>
        {revealed && (
          <span className="ph-back__note" role="status">
            Opened the folder.
          </span>
        )}
        {error && (
          <span className="ph-back__note ph-back__note--problem" role="status">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
