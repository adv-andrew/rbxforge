import react from "@vitejs/plugin-react";
import { writeFile } from "node:fs/promises";
import { defineConfig } from "vite";

const cspNonce = process.env.RBXFORGE_CSP_NONCE;
const inventoryPath = process.env.RBXFORGE_RENDERER_INVENTORY;
if (cspNonce === undefined || !/^[A-Za-z0-9_-]{32,128}$/.test(cspNonce)) {
  throw new Error("RBXFORGE_CSP_NONCE must contain one generated desktop build nonce.");
}
if (inventoryPath === undefined) {
  throw new Error("RBXFORGE_RENDERER_INVENTORY must name the retained module inventory.");
}

export default defineConfig({
  plugins: [react(), retainModuleInventory(inventoryPath)],
  root: "src/renderer",
  base: "./",
  html: {
    cspNonce,
  },
  build: {
    emptyOutDir: true,
    outDir: "../../dist/renderer",
    sourcemap: false,
  },
});

function retainModuleInventory(path: string) {
  const modules = new Set<string>();
  return {
    name: "rbxforge-retain-renderer-inventory",
    moduleParsed(info: { readonly id: string }) {
      modules.add(info.id);
    },
    async closeBundle() {
      await writeFile(path, `${JSON.stringify([...modules].sort(), undefined, 2)}\n`, "utf8");
    },
  };
}
