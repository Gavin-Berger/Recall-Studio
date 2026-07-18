export type PreviewBounce = {
  id: string;
  fileName: string;
  sourcePath?: string;
  durationSec: number;
  timedComments?: Array<{
    timeSec: number;
    text: string;
  }>;
};

export type PreviewTrack = {
  id: string;
  title: string;
  comment?: string;
  bounces: PreviewBounce[];
  finalBounceId: string | null;
};

export type ReleasePreviewTrack<TBounce extends PreviewBounce = PreviewBounce> = {
  trackId: string;
  title: string;
  comment: string;
  bounce: TBounce;
};

export type ReleasePreviewProject = {
  name: string;
  artist: string;
  releaseDate: string;
  notes: string;
  releaseType: "album" | "ep" | "single";
  coverImageDataUrl: string | null;
  tracks: PreviewTrack[];
};

export function selectReleasePreviewTracks<TBounce extends PreviewBounce>(
  project: {
    tracks: Array<Omit<PreviewTrack, "bounces"> & { bounces: TBounce[] }>;
  },
): ReleasePreviewTrack<TBounce>[] {
  return project.tracks.flatMap((track, index) => {
    const bounce = track.bounces.find((candidate) => candidate.id === track.finalBounceId);
    if (!bounce) return [];
    return [{
      trackId: track.id,
      title: track.title.trim() || `Track ${index + 1}`,
      comment: track.comment?.trim() ?? "",
      bounce,
    }];
  });
}

function portableSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "track";
}

export function portableTrackFileName(
  index: number,
  title: string,
  sourceFileName: string,
): string {
  const extensionMatch = sourceFileName.toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  const extension = extensionMatch?.[1] ?? "wav";
  return `${String(index + 1).padStart(2, "0")}-${portableSlug(title)}.${extension}`;
}

export function portablePreviewFolderName(releaseName: string): string {
  return `${portableSlug(releaseName || "untitled-release")}-preview`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export type PortablePreviewTrack = {
  title: string;
  durationSec: number;
  audioFileName: string;
};

export type PortableCoverAsset = {
  fileName: string;
  bytes: number[];
};

export function portableCoverAsset(dataUrl: string | null): PortableCoverAsset | null {
  if (!dataUrl) return null;
  const match = dataUrl.match(/^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  const decoded = atob(match[2].replace(/\s/g, ""));
  return {
    fileName: `cover.${extension}`,
    bytes: Array.from(decoded, (character) => character.charCodeAt(0)),
  };
}

function formatCommentTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function buildReleaseCommentsText<TBounce extends PreviewBounce>(
  project: Pick<ReleasePreviewProject, "name" | "artist" | "releaseDate" | "notes">,
  tracks: ReleasePreviewTrack<TBounce>[],
): string {
  const releaseName = project.name.trim() || "Untitled release";
  const artist = project.artist.trim() || "Unknown artist";
  const lines = [
    releaseName,
    artist,
    project.releaseDate.trim(),
    "",
  ];
  if (project.notes.trim()) {
    lines.push("RELEASE NOTES", project.notes.trim(), "");
  }
  lines.push("TRACK COMMENTS", "");

  tracks.forEach((track, index) => {
    lines.push(
      `${String(index + 1).padStart(2, "0")} - ${track.title}`,
      `Final mix: ${track.bounce.fileName}`,
      `Track notes: ${track.comment || "None"}`,
    );
    const comments = [...(track.bounce.timedComments ?? [])]
      .filter((comment) => comment.text.trim())
      .sort((a, b) => a.timeSec - b.timeSec);
    if (comments.length === 0) {
      lines.push("Timestamped comments: None");
    } else {
      lines.push("Timestamped comments:");
      comments.forEach((comment) => {
        lines.push(`  [${formatCommentTime(comment.timeSec)}] ${comment.text.trim()}`);
      });
    }
    lines.push("");
  });

  return `${lines.join("\r\n").trimEnd()}\r\n`;
}

export function buildReleasePreviewHtml(
  project: Omit<ReleasePreviewProject, "tracks">,
  tracks: PortablePreviewTrack[],
  coverFileName?: string,
): string {
  const title = escapeHtml(project.name.trim() || "Untitled release");
  const artist = escapeHtml(project.artist.trim() || "Unknown artist");
  const releaseType = project.releaseType === "ep"
    ? "EP"
    : project.releaseType === "single"
      ? "Single"
      : "Album";
  const date = project.releaseDate
    ? new Date(`${project.releaseDate}T12:00:00`).getFullYear().toString()
    : "";
  const cover = coverFileName
    ? `<img class="cover" src="${escapeHtml(coverFileName)}" alt="${title} cover">`
    : `<div class="cover cover--empty" aria-label="No cover art">R</div>`;
  const notes = project.notes.trim()
    ? `<p class="notes">${escapeHtml(project.notes.trim())}</p>`
    : "";
  const trackRows = tracks.map((track, index) => `
      <li class="track">
        <button class="play" type="button" aria-label="Play ${escapeHtml(track.title)}" data-audio="audio-${index}">▶</button>
        <span class="number">${String(index + 1).padStart(2, "0")}</span>
        <span class="track-title">${escapeHtml(track.title)}</span>
        <span class="duration">${formatDuration(track.durationSec)}</span>
        <audio id="audio-${index}" preload="metadata" src="audio/${escapeHtml(track.audioFileName)}"></audio>
      </li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${artist}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #090b10; color: #f4f6f8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #090b10; }
    .shell { width: min(980px, 100%); margin: 0 auto; padding: 48px 28px 72px; }
    .hero { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 32px; align-items: end; padding-bottom: 34px; border-bottom: 1px solid #252a33; }
    .cover { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; box-shadow: 0 18px 48px rgba(0,0,0,.42); }
    .cover--empty { display: grid; place-items: center; background: #171b23; color: #8ee6c7; font-size: 64px; font-weight: 800; }
    .kind { margin: 0 0 8px; color: #8ee6c7; font-size: 12px; font-weight: 750; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(38px, 7vw, 78px); line-height: .98; overflow-wrap: anywhere; }
    .artist { margin: 14px 0 0; color: #c7cdd6; font-size: 18px; font-weight: 650; }
    .meta { margin: 8px 0 0; color: #8d95a3; font-size: 13px; }
    .notes { max-width: 680px; margin: 26px 0; color: #b8bec8; line-height: 1.65; white-space: pre-wrap; }
    .tracks { margin: 30px 0 0; padding: 0; list-style: none; }
    .track { display: grid; grid-template-columns: 42px 34px minmax(0,1fr) auto; gap: 10px; align-items: center; min-height: 64px; border-bottom: 1px solid #1d222b; }
    .track:hover { background: #10141b; }
    .play { width: 34px; height: 34px; border: 1px solid #343b47; border-radius: 50%; background: #151a22; color: #f4f6f8; cursor: pointer; }
    .play.is-playing { border-color: #8ee6c7; color: #8ee6c7; }
    .number, .duration { color: #7f8896; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .track-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    footer { margin-top: 36px; color: #68717f; font-size: 11px; text-transform: uppercase; }
    @media (max-width: 620px) {
      .shell { padding: 24px 18px 48px; }
      .hero { grid-template-columns: 1fr; align-items: start; }
      .cover { width: min(72vw, 280px); }
      .track { grid-template-columns: 38px 28px minmax(0,1fr) auto; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      ${cover}
      <div>
        <p class="kind">${releaseType}</p>
        <h1>${title}</h1>
        <p class="artist">${artist}</p>
        <p class="meta">${tracks.length} track${tracks.length === 1 ? "" : "s"}${date ? ` · ${date}` : ""}</p>
      </div>
    </section>
    ${notes}
    <ol class="tracks">${trackRows}</ol>
    <footer>Shared from Recall Studio</footer>
  </main>
  <script>
    const players = [...document.querySelectorAll("audio")];
    const buttons = [...document.querySelectorAll("[data-audio]")];
    for (const button of buttons) {
      button.addEventListener("click", async () => {
        const player = document.getElementById(button.dataset.audio);
        if (player.paused) {
          for (const other of players) if (other !== player) other.pause();
          await player.play();
        } else {
          player.pause();
        }
      });
    }
    for (const player of players) {
      const button = document.querySelector('[data-audio="' + player.id + '"]');
      player.addEventListener("play", () => { button.textContent = "❚❚"; button.classList.add("is-playing"); });
      const reset = () => { button.textContent = "▶"; button.classList.remove("is-playing"); };
      player.addEventListener("pause", reset);
      player.addEventListener("ended", reset);
    }
  </script>
</body>
</html>`;
}
