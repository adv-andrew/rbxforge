import { describe, expect, it } from "vitest";
import { decideMutation, verifyMutation } from "./index.js";

describe("mutation policy", () => {
  it("automatically approves reads", () => {
    expect(
      decideMutation({
        kind: "read",
        operation: "read",
        target: "game.Workspace.Part",
      }),
    ).toEqual({ disposition: "auto" });
  });

  it("previews a Studio-owned single property write", () => {
    expect(
      decideMutation({
        kind: "studio",
        operation: "property-write",
        target: "game.Workspace.Part.Anchored",
        ownership: "studio",
        instanceId: "studio-a",
        connectedInstanceCount: 1,
      }),
    ).toEqual({ disposition: "preview" });
  });

  it("requires session-only confirmation for files-owned live writes", () => {
    expect(
      decideMutation({
        kind: "studio",
        operation: "property-write",
        target: "game.Workspace.Part.Anchored",
        ownership: "files",
        instanceId: "studio-a",
      }),
    ).toEqual({
      disposition: "confirm-session-only",
      warning: "Session-only; Rojo may overwrite this",
    });
  });

  it("previews a normal filesystem write", () => {
    expect(
      decideMutation({
        kind: "filesystem",
        operation: "file-edit",
        target: "game.Workspace.NewPart",
        ownership: "files",
      }),
    ).toEqual({ disposition: "preview" });
  });

  it.each(["unknown", "drift"] as const)("blocks %s-owned writes", (ownership) => {
    expect(
      decideMutation({
        kind: "filesystem",
        operation: "property-write",
        target: "game.Workspace.Part.Anchored",
        ownership,
      }).disposition,
    ).toBe("blocked");
  });

  it.each(["unknown", "drift"] as const)("keeps %s-owned dangerous operations read-only", (ownership) => {
    expect(
      decideMutation({
        kind: "studio",
        operation: "delete",
        target: "game.Workspace.Part",
        ownership,
        instanceId: "studio-a",
      }).disposition,
    ).toBe("blocked");
  });

  it.each([
    ["delete", "studio"],
    ["bulk", "filesystem"],
    ["arbitrary-luau", "studio"],
    ["upload", "filesystem"],
    ["publish", "studio"],
    ["external-command", "command"],
  ] as const)("requires dangerous confirmation for %s", (operation, kind) => {
    expect(
      decideMutation({
        kind,
        operation,
        target: "game.Workspace.Part",
        ownership: "studio",
        instanceId: "studio-a",
      }),
    ).toEqual({ disposition: "confirm-dangerous" });
  });

  it("blocks ambiguous Studio writes across multiple connected instances", () => {
    expect(
      decideMutation({
        kind: "studio",
        operation: "property-write",
        target: "game.Workspace.Part.Anchored",
        ownership: "studio",
        connectedInstanceCount: 2,
      }),
    ).toEqual({
      disposition: "blocked",
      reason: "Studio mutation requires an instanceId when multiple instances are connected",
    });
  });
});

describe("mutation verification", () => {
  it("verifies deeply equal expected and actual values", () => {
    expect(verifyMutation({ alpha: 1, beta: ["x", { gamma: true }] }, { beta: ["x", { gamma: true }], alpha: 1 })).toBe(
      "verified",
    );
  });

  it("reports unequal values as a mismatch", () => {
    expect(verifyMutation({ Anchored: false }, { Anchored: true })).toBe("mismatch");
  });

  it("reports missing actual data as unverifiable", () => {
    expect(verifyMutation({ Anchored: false }, undefined)).toBe("unverifiable");
  });

  it("ignores object-key order while preserving array order", () => {
    expect(
      verifyMutation(
        { properties: { alpha: 1, beta: ["first", "second"] } },
        { properties: { beta: ["first", "second"], alpha: 1 } },
      ),
    ).toBe("verified");
    expect(verifyMutation(["first", "second"], ["second", "first"])).toBe("mismatch");
  });
});
