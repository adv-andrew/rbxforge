import { describe, expect, it } from "vitest";
import { MutationJournal } from "./index.js";

describe("MutationJournal", () => {
  it("keeps immutable copies of appended entries and returned snapshots", () => {
    const journal = new MutationJournal();
    const entry = {
      id: "mutation-1",
      timestamp: "2026-07-28T00:00:00.000Z",
      kind: "studio" as const,
      operation: "property-write" as const,
      target: "game.Workspace.Part.Anchored",
      before: { Anchored: false, nested: ["original"] },
      requested: { Anchored: true },
      result: "applied" as const,
    };

    journal.append(entry);
    entry.before.nested[0] = "changed-by-caller";

    const firstSnapshot = journal.entries();
    const firstEntry = firstSnapshot[0];
    if (firstEntry === undefined || firstEntry.before === undefined) {
      throw new Error("Expected appended entry in journal");
    }

    expect(firstEntry.before).toEqual({ Anchored: false, nested: ["original"] });
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(Object.isFrozen(firstEntry)).toBe(true);
    expect(() => {
      (firstEntry.before as { nested: string[] }).nested[0] = "mutated-snapshot";
    }).toThrow();
    expect(journal.entries()[0]?.before).toEqual({ Anchored: false, nested: ["original"] });
  });

  it("rejects duplicate journal IDs", () => {
    const journal = new MutationJournal();
    const entry = {
      id: "mutation-1",
      timestamp: "2026-07-28T00:00:00.000Z",
      kind: "filesystem" as const,
      operation: "file-edit" as const,
      target: "game.Workspace.Part",
      result: "approved" as const,
    };

    journal.append(entry);

    expect(() => journal.append(entry)).toThrow("Duplicate mutation journal entry ID: mutation-1");
  });
});
