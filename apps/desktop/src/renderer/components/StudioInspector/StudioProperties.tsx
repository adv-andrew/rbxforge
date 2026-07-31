import { Search } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";

import type { StudioInspectorProperty, StudioInspectorPropertyCategory } from "../../../shared/domain.js";
import type { PropertyLoadState } from "../../app/studio-inspector-model.js";
import styles from "./StudioInspector.module.css";

export interface StudioPropertiesProps {
  readonly filterInputRef: RefObject<HTMLInputElement | null>;
  readonly onRetry: () => void;
  readonly properties: PropertyLoadState | undefined;
  readonly selectedPath: string | undefined;
}

const CATEGORY_ORDER: readonly StudioInspectorPropertyCategory[] = [
  "Appearance",
  "Behavior",
  "Transform",
  "Layout",
  "Content",
  "Data",
  "Other",
];

export function StudioProperties({ filterInputRef, onRetry, properties, selectedPath }: StudioPropertiesProps) {
  const [filter, setFilter] = useState("");

  useEffect(() => setFilter(""), [selectedPath]);

  const groups = useMemo(
    () => (properties?.status === "ready" ? groupProperties(properties.rows, filter) : []),
    [filter, properties],
  );

  if (selectedPath === undefined || properties === undefined) {
    return <div className={styles.centerState}>Select an object to inspect its properties.</div>;
  }
  if (properties.status === "loading") {
    return (
      <div className={styles.centerState} role="status">
        <span className={styles.spinner} />
        Loading properties…
      </div>
    );
  }
  if (properties.status === "error") {
    return (
      <div className={styles.propertyError} role="alert">
        <span>{properties.message}</span>
        <button aria-label="Retry properties" className={styles.retry} onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    );
  }

  const selectedName = finalInstanceName(selectedPath);
  const observedAt = new Date(properties.observedAt).toISOString();
  const observedLabel = `Observed ${observedAt.slice(0, -1).replace("T", " ")} UTC`;
  return (
    <div className={styles.properties}>
      <div className={styles.selectionIdentity}>
        <div className={styles.selectionHeading}>
          <strong title={selectedName}>{selectedName}</strong>
          <span className={styles.selectionClass}>{properties.className}</span>
        </div>
        <code className={styles.selectionPath} data-ellipsized="true" title={selectedPath}>
          {selectedPath}
        </code>
        <time className={styles.observedAt} dateTime={observedAt}>
          {observedLabel}
        </time>
      </div>
      <label className={styles.filter}>
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <span className={styles.visuallyHidden}>Filter properties</span>
        <input
          aria-label="Filter properties"
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder="Filter properties"
          ref={filterInputRef}
          type="search"
          value={filter}
        />
        <kbd aria-hidden="true">/</kbd>
      </label>
      <div aria-label="Properties list" aria-live="polite" className={styles.propertyList} tabIndex={0}>
        {properties.rows.length === 0 ? (
          <div className={styles.centerState}>No properties available</div>
        ) : groups.length === 0 ? (
          <div className={styles.centerState}>No matching properties</div>
        ) : (
          groups.map(({ category, rows }) => (
            <section className={styles.propertyGroup} key={category}>
              <h3>{category}</h3>
              <dl>
                {rows.map((property) => (
                  <div className={styles.propertyRow} key={`${category}:${property.name}`}>
                    <dt title={property.name}>{property.name}</dt>
                    <dd>
                      <code data-value-kind={property.valueKind} title={property.value}>
                        {property.value}
                      </code>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

const QUOTED_FINAL_SEGMENT = /\[((?:"(?:\\.|[^"\\])*"))\]$/;
const IDENTIFIER_FINAL_SEGMENT = /\.([A-Za-z_][A-Za-z0-9_]*)$/;

function finalInstanceName(path: string): string {
  const quoted = QUOTED_FINAL_SEGMENT.exec(path)?.[1];
  if (quoted !== undefined) {
    try {
      const parsed: unknown = JSON.parse(quoted);
      if (typeof parsed === "string" && parsed.length > 0) return parsed;
    } catch {
      return "Object";
    }
  }
  return IDENTIFIER_FINAL_SEGMENT.exec(path)?.[1] ?? (path === "game" ? "game" : "Object");
}

function groupProperties(
  properties: readonly StudioInspectorProperty[],
  filter: string,
): readonly {
  readonly category: StudioInspectorPropertyCategory;
  readonly rows: readonly StudioInspectorProperty[];
}[] {
  const query = filter.trim().toLowerCase();
  return CATEGORY_ORDER.map((category) => ({
    category,
    rows: properties
      .filter(
        (property) =>
          property.category === category && (query.length === 0 || property.name.toLowerCase().includes(query)),
      )
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  })).filter(({ rows }) => rows.length > 0);
}
