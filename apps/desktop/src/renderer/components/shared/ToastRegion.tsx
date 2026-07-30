import styles from "./SharedControls.module.css";

export interface Toast {
  id: string;
  message: string;
  tone: "success" | "error";
}

export interface ToastRegionProps {
  toasts: readonly Toast[];
  onDismiss?: (id: string) => void;
}

export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  const successes = toasts.filter(({ tone }) => tone === "success");
  const errors = toasts.filter(({ tone }) => tone === "error");
  return (
    <aside className={styles.toastRegion} aria-label="Notifications">
      <div aria-atomic="false" aria-live="polite" role="status">
        {successes.map((toast) => (
          <div className={styles.toast} key={toast.id}>
            <span>{toast.message}</span>
            {onDismiss ? (
              <button
                aria-label={`Dismiss ${toast.message}`}
                className={styles.toastDismiss}
                onClick={() => onDismiss(toast.id)}
                type="button"
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <div aria-atomic="false" aria-live="assertive" role="alert">
        {errors.map((toast) => (
          <div className={[styles.toast, styles.toastError].join(" ")} key={toast.id}>
            <span>{toast.message}</span>
            {onDismiss ? (
              <button
                aria-label={`Dismiss ${toast.message}`}
                className={styles.toastDismiss}
                onClick={() => onDismiss(toast.id)}
                type="button"
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
