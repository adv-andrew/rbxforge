import { type ButtonHTMLAttributes, type ReactNode } from "react";

import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  children: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  variant?: ButtonVariant;
}

export function Button({
  children,
  className,
  disabled = false,
  loading = false,
  loadingLabel,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  const { style: _runtimeStyle, ...safeProps } = props as typeof props & { style?: unknown };
  void _runtimeStyle;
  const accessibleLoadingLabel = loadingLabel ?? (typeof children === "string" ? children : "Working");
  return (
    <button
      {...safeProps}
      aria-busy={loading || undefined}
      aria-label={loading ? accessibleLoadingLabel : safeProps["aria-label"]}
      className={[styles.button, styles[variant], loading && styles.loading, className].filter(Boolean).join(" ")}
      data-button-variant={variant}
      disabled={disabled || loading}
      type={type}
    >
      <span aria-hidden={loading || undefined} className={styles.label}>
        {children}
      </span>
    </button>
  );
}
