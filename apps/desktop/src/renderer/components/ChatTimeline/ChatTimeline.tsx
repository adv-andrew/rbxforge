import type { MessageRecord } from "../../../shared/domain.js";

import styles from "./ChatTimeline.module.css";

export interface ChatTimelineProps {
  readonly messages: readonly MessageRecord[];
  readonly threadId?: string;
}

export function ChatTimeline({ messages, threadId }: ChatTimelineProps) {
  const visible = threadId === undefined ? [] : messages.filter((message) => message.threadId === threadId);
  return (
    <section aria-label="Conversation history" className={styles.timeline} tabIndex={0}>
      <div className={styles.content}>
        {visible.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyKeyline} aria-hidden="true" />
            <p>Start a local project note or prompt. AI is not connected yet.</p>
          </div>
        ) : (
          <div className={styles.entries}>
            {visible.map((message) => (
              <article
                aria-label={message.role === "user" ? "Local prompt" : "System note"}
                className={message.role === "user" ? styles.userEntry : styles.systemEntry}
                key={message.id}
              >
                <span className={styles.role}>{message.role === "user" ? "You" : "RbxForge"}</span>
                <p>{message.content}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
