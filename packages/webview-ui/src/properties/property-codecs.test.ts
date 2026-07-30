import { describe, expect, test } from "vitest";

import { createPropertyCodec } from "./property-codecs.js";

describe("conservative property codecs", () => {
  test.each([
    ["boolean", "true", true],
    ["boolean", "false", false],
    ["number", "-12.5", -12.5],
    ["string", "hello", "hello"],
    ["Color3", '{"R":0.1,"G":0.2,"B":1}', { R: 0.1, G: 0.2, B: 1 }],
    ["Vector2", '{"X":1,"Y":-2}', { X: 1, Y: -2 }],
    ["Vector3", '{"X":1,"Y":-2,"Z":3}', { X: 1, Y: -2, Z: 3 }],
    ["UDim", '{"Scale":0.5,"Offset":12}', { Scale: 0.5, Offset: 12 }],
    [
      "UDim2",
      '{"_type":"UDim2","X":{"Scale":0.5,"Offset":12},"Y":{"Scale":1,"Offset":-4}}',
      { _type: "UDim2", X: { Scale: 0.5, Offset: 12 }, Y: { Scale: 1, Offset: -4 } },
    ],
    ["CFrame", "1,2,3,1,0,0,0,1,0,0,0,1", [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1]],
  ] as const)("parses verified %s values", (kind, input, expected) => {
    expect(createPropertyCodec(kind).parse(input)).toEqual({ ok: true, value: expected });
  });

  test("accepts only exact host-supplied enum options", () => {
    const codec = createPropertyCodec("enum", ["Plastic", "Wood"]);
    expect(codec.parse("Wood")).toEqual({ ok: true, value: "Wood" });
    expect(codec.parse("wood")).toMatchObject({ ok: false });
    expect(createPropertyCodec("enum").editable).toBe(false);
  });

  test.each([
    ["boolean", "TRUE"],
    ["boolean", "0"],
    ["number", "NaN"],
    ["number", "Infinity"],
    ["number", "1e999"],
    ["Color3", '{"R":-0.1,"G":0,"B":0}'],
    ["Color3", '{"R":0,"G":0,"B":1.1}'],
    ["Vector2", '{"X":1,"Y":2,"Z":3}'],
    ["Vector3", "1,2,3"],
    ["UDim", '{"Scale":0,"Offset":"4"}'],
    ["UDim2", '{"X":{"Scale":0,"Offset":0},"Y":{"Scale":0,"Offset":0}}'],
    ["UDim2", '{"_type":"UDim2","X":{"Scale":0,"Offset":0},"Y":{"Scale":0,"Offset":0},"extra":true}'],
    ["CFrame", "1,2,3,1,0,0,0,1,0,0,0"],
    ["CFrame", "1,2,3,2,0,0,0,1,0,0,0,1"],
    ["CFrame", "1,2,3,1,0,0,1,0,0,0,0,1"],
    ["Color3", "ambiguous string"],
    ["unknown", '{"X":1,"Y":2}'],
  ] as const)("rejects invalid or ambiguous %s input %#", (kind, input) => {
    expect(createPropertyCodec(kind).parse(input)).toMatchObject({ ok: false });
  });

  test.each(["CFrame", "UDim", "unknown"] as const)("%s remains display-only", (kind) => {
    expect(createPropertyCodec(kind).editable).toBe(false);
  });

  test("never accepts non-finite generated numeric inputs", () => {
    for (const value of ["NaN", "Infinity", "-Infinity", "1e10000", "--1", ""]) {
      expect(createPropertyCodec("number").parse(value)).toMatchObject({ ok: false });
    }
  });
});
