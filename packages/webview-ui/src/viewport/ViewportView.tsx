import { useEffect, useRef, useState, type JSX } from "react";

import type { ViewportCaptureMessage } from "../protocol.js";

export interface ViewportViewProps {
  readonly capture?: ViewportCaptureMessage;
  readonly state?: "empty" | "loading" | "error";
  readonly detail?: string;
  readonly onCapture?: () => void;
}

interface ViewportBlob {
  readonly capture: ViewportCaptureMessage;
  readonly url: string;
}

export function ViewportView(props: ViewportViewProps): JSX.Element {
  const [items, setItems] = useState<readonly ViewportBlob[]>([]);
  const itemsRef = useRef<readonly ViewportBlob[]>([]);
  useEffect(() => {
    const capture = props.capture;
    if (capture === undefined) return;
    if (itemsRef.current.some((item) => item.capture.captureId === capture.captureId)) {
      setItems((current) => {
        const updated = Object.freeze(
          current.map((item) => (item.capture.captureId === capture.captureId ? { ...item, capture } : item)),
        );
        itemsRef.current = updated;
        return updated;
      });
      return;
    }
    const url = URL.createObjectURL(new Blob([decodeBase64(capture.data)], { type: capture.mimeType }));
    setItems((current) => {
      const next = [...current, { capture, url }];
      const evicted = next.slice(0, Math.max(0, next.length - 3));
      for (const item of evicted) URL.revokeObjectURL(item.url);
      const retained = Object.freeze(next.slice(-3));
      itemsRef.current = retained;
      return retained;
    });
  }, [props.capture]);
  useEffect(
    () => () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.url);
      itemsRef.current = [];
    },
    [],
  );

  const current = items.at(-1);
  return (
    <section className="viewport-view" aria-label="Viewport capture">
      <header className="view-header">
        <div>
          <h1>Viewport</h1>
          <p>Native Roblox viewport capture</p>
        </div>
        {props.onCapture === undefined ? null : (
          <button type="button" onClick={props.onCapture}>
            Capture
          </button>
        )}
      </header>
      {props.state === "loading" ? <p className="notice loading-state">Capturing viewport…</p> : null}
      {props.state === "error" ? <p className="notice error-state">{props.detail ?? "Capture failed"}</p> : null}
      {current === undefined ? (
        props.state === "loading" || props.state === "error" ? null : (
          <p className="notice empty-state">No viewport capture</p>
        )
      ) : (
        <figure>
          <img src={current.url} alt="Roblox viewport capture" />
          <figcaption>
            <strong>{current.capture.freshness === "stale" ? "Stale capture" : "Fresh capture"}</strong>
            <span>
              {dimensionLabel(current.capture)} · {current.capture.format}
              {qualityLabel(current.capture)}
            </span>
            <span>
              Target {current.capture.target} · captured {current.capture.capturedAt}
            </span>
          </figcaption>
        </figure>
      )}
      {items.length <= 1 ? null : (
        <ol className="capture-history" aria-label="Capture history">
          {items.slice(0, -1).map((item) => (
            <li key={item.capture.captureId}>{item.capture.capturedAt}</li>
          ))}
        </ol>
      )}
    </section>
  );
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer as ArrayBuffer;
}

function dimensionLabel(capture: ViewportCaptureMessage): string {
  return capture.width === undefined || capture.height === undefined
    ? "Native dimensions unavailable"
    : `${capture.width} × ${capture.height} native`;
}

function qualityLabel(capture: ViewportCaptureMessage): string {
  return capture.quality === undefined ? "" : ` q${capture.quality}`;
}
