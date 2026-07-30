import { z } from "zod";

export type RecoveryAction =
  | "none"
  | "retry"
  | "reconnect"
  | "choose-rojo"
  | "install-plugin"
  | "show-plugins-folder"
  | "choose-place"
  | "copy-mcp-url";

export interface DesktopError {
  readonly layer: "storage" | "project" | "rojo" | "mcp" | "studio" | "plugin" | "ipc" | "app";
  readonly code: string;
  readonly message: string;
  readonly diagnostic?: string;
  readonly recovery: { readonly action: RecoveryAction; readonly label: string };
}

export const recoveryActionSchema = z.enum([
  "none",
  "retry",
  "reconnect",
  "choose-rojo",
  "install-plugin",
  "show-plugins-folder",
  "choose-place",
  "copy-mcp-url",
]);

export const desktopErrorSchema = z
  .object({
    layer: z.enum(["storage", "project", "rojo", "mcp", "studio", "plugin", "ipc", "app"]),
    code: z.string().min(1),
    message: z.string().max(500),
    diagnostic: z.string().max(2_000).optional(),
    recovery: z.object({ action: recoveryActionSchema, label: z.string().min(1) }).strict(),
  })
  .strict()
  .transform((error) =>
    toDesktopError({
      layer: error.layer,
      code: error.code,
      message: error.message,
      ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
      recovery: error.recovery,
    }),
  );

/** Produces a bounded, renderer-safe error before it is placed in a snapshot. */
export function toDesktopError(error: DesktopError): DesktopError {
  return Object.freeze({
    ...error,
    message: error.message.slice(0, 500),
    ...(error.diagnostic === undefined ? {} : { diagnostic: redactDiagnostic(error.diagnostic).slice(0, 2_000) }),
    recovery: Object.freeze({ ...error.recovery }),
  });
}

function redactDiagnostic(value: string): string {
  return value.replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
