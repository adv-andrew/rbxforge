import { describe, expect, test, vi } from "vitest";

import * as Agent from "./index.js";

interface Evaluation {
  readonly results: readonly Readonly<{ path: string; ignored: boolean }>[];
  readonly attestation: object;
}

interface Policy {
  evaluate(paths: readonly string[], signal: AbortSignal): Promise<Evaluation>;
  isCurrent(attestation: object): boolean;
  invalidate(): void;
  dispose(): void;
}

type PolicyConstructor = new (
  options: Readonly<{
    evaluate(path: string, signal: AbortSignal): boolean | Promise<boolean>;
    subscribe?: (invalidate: () => void) => Readonly<{ dispose(): void }>;
  }>,
) => Policy;

function policyConstructor(): PolicyConstructor {
  const constructor = (
    Agent as unknown as {
      readonly RevisionedIgnorePolicy?: PolicyConstructor;
    }
  ).RevisionedIgnorePolicy;
  expect(constructor).toBeTypeOf("function");
  return constructor!;
}

describe("RevisionedIgnorePolicy", () => {
  test("binds an unchanged multi-path result to one current opaque attestation", async () => {
    const Policy = policyConstructor();
    const policy = new Policy({
      evaluate: async (path) => path.endsWith("ignored.lua"),
    });

    const evaluation = await policy.evaluate(
      ["/workspace/main.lua", "/workspace/ignored.lua"],
      new AbortController().signal,
    );

    expect(evaluation.results).toEqual([
      { path: "/workspace/main.lua", ignored: false },
      { path: "/workspace/ignored.lua", ignored: true },
    ]);
    expect(Object.isFrozen(evaluation.results)).toBe(true);
    expect(Object.keys(evaluation.attestation)).toEqual([]);
    expect(policy.isCurrent(evaluation.attestation)).toBe(true);
    policy.dispose();
  });

  test("invalidates the whole multi-path attestation when policy changes during any check", async () => {
    const Policy = policyConstructor();
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = new Policy({
      evaluate: async (path) => {
        if (path.endsWith("second.lua")) {
          entered();
          await waiting;
        }
        return false;
      },
    });
    const evaluating = policy.evaluate(["/workspace/first.lua", "/workspace/second.lua"], new AbortController().signal);

    await reached;
    policy.invalidate();
    release();
    const evaluation = await evaluating;

    expect(evaluation.results.every((result) => !result.ignored)).toBe(true);
    expect(policy.isCurrent(evaluation.attestation)).toBe(false);
    policy.dispose();
  });

  test("subscription invalidation and disposal revoke attestations and fail closed", async () => {
    const Policy = policyConstructor();
    let invalidate!: () => void;
    const dispose = vi.fn();
    const policy = new Policy({
      evaluate: async () => false,
      subscribe: (listener) => {
        invalidate = listener;
        return { dispose };
      },
    });
    const evaluation = await policy.evaluate(["/workspace/main.lua"], new AbortController().signal);

    invalidate();
    expect(policy.isCurrent(evaluation.attestation)).toBe(false);
    policy.dispose();
    policy.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(policy.isCurrent(evaluation.attestation)).toBe(false);
    await expect(policy.evaluate(["/workspace/main.lua"], new AbortController().signal)).rejects.toThrow("disposed");
  });
});
