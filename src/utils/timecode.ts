export function formatSessionTimecode(milliseconds: number): string {
  const safeMilliseconds = Number.isFinite(milliseconds)
    ? Math.max(0, milliseconds)
    : 0;

  const totalSeconds = Math.floor(safeMilliseconds / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((unit) => String(unit).padStart(2, "0"))
    .join(":");
}

export function getSessionElapsedTime(
  timestamp: number,
  sessionStartedAt: number | null
): string {
  if (!sessionStartedAt) {
    return "00:00:00";
  }

  return formatSessionTimecode(timestamp - sessionStartedAt);
}