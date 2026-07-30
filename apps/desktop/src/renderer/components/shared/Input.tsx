import { type InputHTMLAttributes, useId } from "react";

import styles from "./SharedControls.module.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "aria-describedby" | "style"> {
  error?: string;
  help?: string;
  label: string;
}

export function Input({ error, help, id, label, ...props }: InputProps) {
  const { style: _runtimeStyle, ...safeProps } = props as typeof props & { style?: unknown };
  void _runtimeStyle;
  const generatedId = useId();
  const inputId = id ?? `input-${generatedId}`;
  const description = error ?? help;
  const descriptionId = description ? `${inputId}-description` : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={inputId}>
        {label}
      </label>
      <input
        {...safeProps}
        aria-describedby={descriptionId}
        aria-invalid={error ? true : undefined}
        className={styles.input}
        id={inputId}
      />
      {description ? (
        <span className={error ? styles.fieldError : styles.fieldHelp} id={descriptionId}>
          {description}
        </span>
      ) : null}
    </div>
  );
}
