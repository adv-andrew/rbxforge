import type { RbxForgeApi } from "./index.js";

declare global {
  interface Window {
    readonly rbxforge: Readonly<RbxForgeApi>;
  }
}

export {};
