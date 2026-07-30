import { type ButtonHTMLAttributes, type ReactNode } from "react";

import styles from "./SharedControls.module.css";

type NonEmptyLiteral<Value extends string> = Value extends "" ? never : Value;

export type IconButtonProps<Label extends string> = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children" | "style"
> & {
  ariaLabel: NonEmptyLiteral<Label>;
  icon: ReactNode;
};

export function IconButton<const Label extends string>({
  ariaLabel,
  className,
  icon,
  type = "button",
  ...props
}: IconButtonProps<Label>) {
  if (ariaLabel.trim().length === 0) {
    throw new Error("IconButton requires a non-empty aria label.");
  }
  const { style: _runtimeStyle, ...safeProps } = props as typeof props & { style?: unknown };
  void _runtimeStyle;
  return (
    <button
      {...safeProps}
      aria-label={ariaLabel}
      className={[styles.iconButton, className].filter(Boolean).join(" ")}
      type={type}
    >
      <span aria-hidden="true" className={styles.icon}>
        {icon}
      </span>
    </button>
  );
}
