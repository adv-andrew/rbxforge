import { Button } from "../shared/Button.js";
import { Dialog } from "../shared/Dialog.js";
import styles from "./ProjectSidebar.module.css";

export interface AboutDialogProps {
  readonly onDismiss: () => void;
  readonly open: boolean;
}

export function AboutDialog({ onDismiss, open }: AboutDialogProps) {
  return (
    <Dialog
      description="Application information and local-only status."
      onDismiss={onDismiss}
      open={open}
      title="About RbxForge"
    >
      <div className={styles.aboutContent}>
        <p className={styles.version}>Version 0.1.0</p>
        <p>Project chats and settings stay on this device. AI is not connected.</p>
        <p>RbxForge is an unofficial developer tool and is not affiliated with or endorsed by Roblox Corporation.</p>
        <div className={styles.dialogActions}>
          <Button onClick={onDismiss}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}
