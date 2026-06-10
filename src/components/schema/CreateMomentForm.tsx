import { useState } from "react";
import type { FormEvent } from "react";
import {
  CONFIDENCE_LABEL,
  CONFIDENCE_ORDER,
  MOMENT_TYPE_LABEL,
} from "../../types/schema";
import type { Confidence, MomentType } from "../../types/schema";

export type MomentFormValues = {
  title: string;
  momentType: MomentType;
  confidence: Confidence;
  note: string;
  tags: string[];
};

type CreateMomentFormProps = {
  mode: "create" | "edit";
  initial?: Partial<MomentFormValues>;
  // A short, read-only description of what this moment will be linked to.
  targetSummary?: string;
  onCancel: () => void;
  onSubmit: (values: MomentFormValues) => void;
};

const MOMENT_TYPES = Object.keys(MOMENT_TYPE_LABEL) as MomentType[];

export function CreateMomentForm({
  mode,
  initial,
  targetSummary,
  onCancel,
  onSubmit,
}: CreateMomentFormProps) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [momentType, setMomentType] = useState<MomentType>(
    initial?.momentType ?? "sound_design",
  );
  const [confidence, setConfidence] = useState<Confidence>(
    initial?.confidence ?? "rough",
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));

  function handleSubmit(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    onSubmit({
      title: trimmedTitle,
      momentType,
      confidence,
      note: note.trim(),
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
  }

  return (
    <div className="moment-form__backdrop" role="dialog" aria-modal="true">
      <form className="moment-form" onSubmit={handleSubmit}>
        <h3 className="moment-form__title">
          {mode === "create" ? "Create creative moment" : "Edit creative moment"}
        </h3>

        {targetSummary && (
          <p className="moment-form__target">Linked to: {targetSummary}</p>
        )}

        <label className="moment-form__field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            autoFocus
            placeholder="e.g. Found the bass tone"
            onChange={(changeEvent) => setTitle(changeEvent.target.value)}
          />
        </label>

        <div className="moment-form__row">
          <label className="moment-form__field">
            <span>Type</span>
            <select
              value={momentType}
              onChange={(changeEvent) =>
                setMomentType(changeEvent.target.value as MomentType)
              }
            >
              {MOMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {MOMENT_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </label>

          <label className="moment-form__field">
            <span>Confidence</span>
            <select
              value={confidence}
              onChange={(changeEvent) =>
                setConfidence(changeEvent.target.value as Confidence)
              }
            >
              {CONFIDENCE_ORDER.map((level) => (
                <option key={level} value={level}>
                  {CONFIDENCE_LABEL[level]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="moment-form__field">
          <span>Note</span>
          <textarea
            value={note}
            rows={3}
            placeholder="Why did this matter?"
            onChange={(changeEvent) => setNote(changeEvent.target.value)}
          />
        </label>

        <label className="moment-form__field">
          <span>Tags</span>
          <input
            type="text"
            value={tags}
            placeholder="comma, separated"
            onChange={(changeEvent) => setTags(changeEvent.target.value)}
          />
        </label>

        <div className="moment-form__actions">
          <button type="button" className="schema-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="schema-btn schema-btn--primary" disabled={!title.trim()}>
            {mode === "create" ? "Create moment" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
