import { useEffect, useMemo, useRef, useState, type JSX, type Ref } from "react";

import type { PropertiesSnapshot, PropertyProposal, PropertyRow, TypedPropertyValue } from "../protocol.js";
import { createPropertyCodec } from "./property-codecs.js";

export interface PropertiesViewProps {
  readonly snapshot?: PropertiesSnapshot;
  readonly displayGeneration?: number;
  readonly initialQuery?: string;
  readonly onQueryChange?: (query: string) => void;
  readonly onPropose: (proposal: PropertyProposal) => void;
  readonly onOpenDefiningFile?: (instancePath: string) => void;
}

export function PropertiesView(props: PropertiesViewProps): JSX.Element {
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const filter = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "/" && !isEditingTarget(event.target)) {
        event.preventDefault();
        filter.current?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);

  const filtered = useMemo(
    () =>
      props.snapshot?.properties.filter((property) =>
        property.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ) ?? [],
    [props.snapshot, query],
  );

  if (props.snapshot === undefined) {
    return <p className="notice loading-state">Loading properties…</p>;
  }
  const snapshot = props.snapshot;
  const blocked =
    !snapshot.connected ||
    snapshot.freshness !== "fresh" ||
    snapshot.ownership === "unknown" ||
    snapshot.ownership === "drift" ||
    snapshot.ownership === "shared";
  return (
    <section className="properties-view">
      <header className="view-header" role="banner">
        <div>
          <h1>
            {snapshot.name} <span className="class-name">{snapshot.className}</span>
          </h1>
          <p className="path">{snapshot.instancePath}</p>
          <p>
            {snapshot.placeName} · {snapshot.ownership} · {snapshot.freshness} ·{" "}
            {snapshot.simulation ? "Simulation" : "Live"}
          </p>
        </div>
        {props.onOpenDefiningFile === undefined ? null : (
          <button type="button" onClick={() => props.onOpenDefiningFile?.(snapshot.instancePath)}>
            Open defining file
          </button>
        )}
      </header>
      {!snapshot.connected ? <p className="notice disconnected-state">Studio disconnected</p> : null}
      {snapshot.freshness === "stale" ? <p className="notice stale-state">Showing stale cached values</p> : null}
      {snapshot.ownership === "files" ? (
        <p className="notice warning-state">Session-only; Rojo may overwrite this</p>
      ) : null}
      <label className="filter-field">
        <span>Filter properties</span>
        <input
          ref={filter}
          type="search"
          value={query}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setQuery(next);
            props.onQueryChange?.(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              rowRefs.current[0]?.focus();
            }
          }}
          placeholder="Filter (/)"
        />
      </label>
      {snapshot.properties.length === 0 ? (
        <p className="notice empty-state">No properties available</p>
      ) : (
        <table className="properties-grid">
          <thead>
            <tr>
              <th>Property</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((property, index) => (
              <PropertyEditorRow
                key={property.name}
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                property={property}
                snapshot={snapshot}
                blocked={blocked}
                displayGeneration={props.displayGeneration ?? 1}
                onPropose={props.onPropose}
                onMove={(direction) => {
                  const next = index + direction;
                  rowRefs.current[next]?.focus();
                }}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface RowProps {
  readonly property: PropertyRow;
  readonly snapshot: PropertiesSnapshot;
  readonly blocked: boolean;
  readonly displayGeneration: number;
  readonly onPropose: (proposal: PropertyProposal) => void;
  readonly onMove: (direction: -1 | 1) => void;
}

const PropertyEditorRow = function PropertyEditorRow(
  props: RowProps & { readonly ref?: React.Ref<HTMLTableRowElement> },
): JSX.Element {
  const { ref, ...rowProps } = props;
  return <PropertyEditorRowBody ref={ref} {...rowProps} />;
};

const PropertyEditorRowBody = (
  props: RowProps & { readonly ref?: Ref<HTMLTableRowElement> | undefined },
): JSX.Element => {
  const input = useRef<HTMLInputElement>(null);
  const codec = createPropertyCodec(props.property.kind, props.property.enumOptions);
  const source = formatSource(props.property, codec.format);
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const parsed = codec.parse(draft);
  const drift =
    props.property.comparable &&
    props.property.declaredValue !== undefined &&
    props.property.liveValue !== undefined &&
    !sameValue(props.property.declaredValue, props.property.liveValue);
  const disabled =
    props.blocked ||
    drift ||
    !props.property.editable ||
    !codec.editable ||
    !parsed.ok ||
    (props.property.mutationState !== undefined && props.property.mutationState !== "idle");
  const apply = (): void => {
    if (disabled || !parsed.ok) return;
    props.onPropose({
      instanceId: props.snapshot.instanceId,
      instancePath: props.snapshot.instancePath,
      propertyName: props.property.name,
      snapshotId: props.snapshot.snapshotId,
      value: parsed.value,
      displayGeneration: props.displayGeneration,
    });
  };
  return (
    <tr
      ref={props.ref}
      tabIndex={0}
      data-property={props.property.name}
      className="property-row"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "ArrowDown") props.onMove(1);
        if (event.key === "ArrowUp") props.onMove(-1);
        if (event.key === "Enter") input.current?.focus();
      }}
    >
      <th scope="row">
        <span>{props.property.name}</span>
        <small>
          {props.property.category} · {props.property.kind}
        </small>
      </th>
      <td>
        {drift ? (
          <div className="drift" aria-label="Drift">
            <strong>Drift</strong>
            <span>Declared {displayValue(props.property.declaredValue)}</span>
            <span>Live {displayValue(props.property.liveValue)}</span>
          </div>
        ) : null}
        <div className="editor">
          <input
            ref={input}
            type="text"
            value={draft}
            disabled={!props.property.editable || !codec.editable}
            aria-label={`${props.property.name} value`}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(source);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                apply();
              }
            }}
          />
          <button type="button" onClick={apply} disabled={disabled}>
            Apply
          </button>
          <button type="button" onClick={() => setDraft(source)} disabled={draft === source}>
            Revert
          </button>
        </div>
        {!parsed.ok && props.property.editable ? <small className="error-text">{parsed.message}</small> : null}
        {props.property.blockedReason === undefined ? null : <small>{props.property.blockedReason}</small>}
        {props.property.mutationState === "approval-pending" ? <span className="pending">Approval pending</span> : null}
        {props.property.mutationState === "applying" ? <span className="pending">Applying…</span> : null}
        {props.property.mutationState === "complete" ? (
          <span className="pending">Refreshing verified value…</span>
        ) : null}
        {props.property.verification === undefined ? null : (
          <span className={`verification ${props.property.verification}`}>
            {capitalize(props.property.verification)}
          </span>
        )}
      </td>
    </tr>
  );
};

function formatSource(row: PropertyRow, format: (value: TypedPropertyValue) => string): string {
  if (row.liveValue !== undefined) return format(row.liveValue);
  return row.rawValue ?? "";
}

function displayValue(value: TypedPropertyValue | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function sameValue(left: TypedPropertyValue, right: TypedPropertyValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
}

function capitalize(value: string): string {
  return value.slice(0, 1).toLocaleUpperCase() + value.slice(1);
}
