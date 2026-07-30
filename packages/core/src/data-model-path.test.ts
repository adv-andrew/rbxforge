import { describe, expect, it } from "vitest";
import { formatDataModelPath, joinDataModelPath, parentDataModelPath, parseDataModelPath } from "./data-model-path.js";

describe("DataModel paths", () => {
  it("parses dotted and quoted names without losing punctuation", () => {
    expect(parseDataModelPath('game.Workspace["Door.Hinge"]["Quote\\\\\\"Node"]')).toEqual([
      "game",
      "Workspace",
      "Door.Hinge",
      'Quote\\"Node',
    ]);
  });

  it("formats only identifier-safe segments with dot notation", () => {
    expect(formatDataModelPath(["game", "Workspace", "Door.Hinge", "A B"])).toBe('game.Workspace["Door.Hinge"]["A B"]');
  });

  it("round-trips Unicode, brackets, and backslashes", () => {
    const segments = ["game", "Workspace", "門", "A]B", "C\\\\D"];
    expect(parseDataModelPath(formatDataModelPath(segments))).toEqual(segments);
  });

  it("rejects paths outside game", () => {
    expect(() => parseDataModelPath("workspace.Part")).toThrow("DataModel path must start with game");
  });

  it("rejects empty quoted segments", () => {
    expect(() => parseDataModelPath('game[""]')).toThrow("DataModel path segments must not be empty");
  });

  it("rejects empty formatter segments", () => {
    expect(() => formatDataModelPath(["game", ""])).toThrow("DataModel path segments must not be empty");
  });

  it("rejects unsupported bracket expressions", () => {
    expect(() => parseDataModelPath("game[1]")).toThrow("DataModel path contains an unsupported bracket expression");
  });

  it("rejects a trailing dot", () => {
    expect(() => parseDataModelPath("game.Workspace.")).toThrow(
      "DataModel path contains an invalid identifier segment",
    );
  });

  it("rejects identifier segments that start with a digit", () => {
    expect(() => parseDataModelPath("game.Workspace.9Door")).toThrow(
      "DataModel path contains an invalid identifier segment",
    );
  });

  it("rejects unclosed quoted segments", () => {
    expect(() => parseDataModelPath('game["Door')).toThrow("DataModel path contains an unclosed quoted segment");
  });

  it("rejects malformed JSON quoted segments", () => {
    expect(() => parseDataModelPath('game["\\q"]')).toThrow("DataModel path contains an invalid quoted segment");
  });

  it("joins and finds parents canonically", () => {
    const child = joinDataModelPath("game.Workspace", "Door.Hinge");
    expect(child).toBe('game.Workspace["Door.Hinge"]');
    expect(parentDataModelPath(child)).toBe("game.Workspace");
    expect(parentDataModelPath("game")).toBeUndefined();
  });
});
