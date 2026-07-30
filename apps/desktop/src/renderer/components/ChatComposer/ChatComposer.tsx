import { type KeyboardEvent, useId } from "react";

import { Button } from "../shared/Button.js";
import styles from "./ChatComposer.module.css";

const CONTENT_LIMIT = 100_000;

export interface ChatComposerProps {
  readonly content: string;
  readonly disabled?: boolean;
  readonly submitDisabled?: boolean;
  readonly error?: string;
  readonly onBlur?: (relatedTarget: EventTarget | null) => void;
  readonly onChange: (content: string) => void;
  readonly onSave: () => void;
}

export function ChatComposer({
  content,
  disabled = false,
  submitDisabled = false,
  error,
  onBlur,
  onChange,
  onSave,
}: ChatComposerProps) {
  const descriptionId = useId();
  const lengthError = content.length > CONTENT_LIMIT ? "Keep this prompt to 100,000 characters or fewer." : undefined;
  const visibleError = lengthError ?? error;
  const canSave = !disabled && !submitDisabled && visibleError === undefined && content.trim().length > 0;
  const submit = () => {
    if (canSave) onSave();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.repeat || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <section aria-label="Local prompt composer" className={styles.region}>
      <div className={styles.composer}>
        <label className={styles.label} htmlFor="local-project-prompt">
          Local project prompt
        </label>
        <textarea
          aria-describedby={descriptionId}
          aria-invalid={visibleError ? true : undefined}
          className={styles.textarea}
          disabled={disabled}
          id="local-project-prompt"
          maxLength={CONTENT_LIMIT}
          onBlur={(event) => onBlur?.(event.relatedTarget)}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Write a local project note or prompt…"
          rows={2}
          value={content}
        />
        <div className={styles.footer}>
          <div className={styles.status} id={descriptionId}>
            <span className={styles.statusDot} aria-hidden="true" />
            <span>{visibleError ?? "AI provider not configured"}</span>
          </div>
          <Button disabled={!canSave} onClick={submit} variant="primary">
            Save prompt
          </Button>
        </div>
      </div>
    </section>
  );
}
