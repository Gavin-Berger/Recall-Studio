import { useEffect, useState } from "react";
import { LoadingSpinner } from "../../components/LoadingSpinner";

export type AlsFileChoice = { name: string; path: string };

// Picks which `.als` version a take's history should belong to. Used to move a
// take onto a renamed file, or fix a wrong auto-link. Shared by the project desk
// and the versions view so relinking behaves identically everywhere.
export function RelinkDialog({
  projectId,
  currentAlsPath,
  busy,
  onList,
  onChoose,
  onClose,
}: {
  projectId: string;
  currentAlsPath: string | null;
  busy: boolean;
  onList: (projectId: string) => Promise<AlsFileChoice[]>;
  onChoose: (alsPath: string) => Promise<void>;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<AlsFileChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    onList(projectId)
      .then((result) => {
        if (mounted) setFiles(result);
      })
      .catch((listError) => {
        if (mounted) setError(String(listError));
      });
    return () => {
      mounted = false;
    };
  }, [projectId, onList]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="relink-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="relink-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="relink-dialog__head">
          <strong>Relink this take to a file</strong>
          <p>Choose the version this take's history belongs to.</p>
        </div>
        {error ? (
          <p className="relink-dialog__empty">{error}</p>
        ) : files === null ? (
          <p className="relink-dialog__empty px-loading-inline" role="status"><LoadingSpinner />Reading folder…</p>
        ) : files.length === 0 ? (
          <p className="relink-dialog__empty">No .als files found in this project's folder.</p>
        ) : (
          <div className="relink-dialog__list">
            {files.map((file) => {
              const current = file.path === currentAlsPath;
              return (
                <button
                  key={file.path}
                  type="button"
                  className={`relink-dialog__file ${current ? "is-current" : ""}`}
                  disabled={busy || current}
                  onClick={async () => {
                    await onChoose(file.path);
                    onClose();
                  }}
                >
                  <span className="relink-dialog__file-name">{file.name}</span>
                  {current && <span className="relink-dialog__current">current</span>}
                </button>
              );
            })}
          </div>
        )}
        <div className="relink-dialog__foot">
          <button type="button" className="px-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
