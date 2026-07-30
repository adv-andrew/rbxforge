import { describe, expect, it } from "vitest";
import { parseRojoSourcemap } from "./sourcemap.js";

describe("parseRojoSourcemap", () => {
  it("projects Rojo's compact native sourcemap into canonical paths with absolute file mappings", () => {
    const result = parseRojoSourcemap({
      name: "Game",
      className: "DataModel",
      children: [
        {
          name: "Workspace",
          className: "Workspace",
          filePaths: ["/repo/src/workspace.model.json"],
        },
      ],
    });

    expect(result).toEqual([
      {
        path: "game",
        name: "Game",
        className: "DataModel",
      },
      {
        path: "game.Workspace",
        name: "Workspace",
        className: "Workspace",
        filePaths: ["/repo/src/workspace.model.json"],
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("accepts omitted or explicitly empty arrays but rejects ambiguous or malformed paths", () => {
    expect(parseRojoSourcemap({ name: "Game", className: "DataModel", filePaths: [], children: [] })).toHaveLength(1);
    expect(() =>
      parseRojoSourcemap({
        name: "Game",
        className: "DataModel",
        children: [
          { name: "Part", className: "Part" },
          { name: "Part", className: "Part" },
        ],
      }),
    ).toThrow("Duplicate canonical sourcemap path: game.Part");
    expect(() => parseRojoSourcemap({ name: "Game", className: "DataModel", children: [{}] })).toThrow(
      "Invalid Rojo sourcemap node",
    );
    expect(() => parseRojoSourcemap({ name: "Game", className: "DataModel", filePaths: ["relative.lua"] })).toThrow(
      "Sourcemap file paths must be absolute",
    );
    expect(() => parseRojoSourcemap({ name: "Game", className: "Folder" })).toThrow(
      "Rojo sourcemap root must have className DataModel",
    );
  });
});
