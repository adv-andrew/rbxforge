import react from "@vitejs/plugin-react";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "rbxforge-bundle-inventory",
      async generateBundle(_options, bundle) {
        const modules = new Set<string>();
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          for (const moduleId of Object.keys(output.modules)) modules.add(moduleId);
        }
        this.addWatchFile(resolve("src/index.ts"));
        const inventoryPath = resolve("../../apps/extension/media/webview/.bundle-inventory.json");
        await mkdir(resolve("../../apps/extension/media/webview"), { recursive: true });
        await writeFile(inventoryPath, `${JSON.stringify([...modules].sort(), undefined, 2)}\n`, "utf8");
      },
    },
  ],
  build: {
    emptyOutDir: true,
    outDir: "../../apps/extension/media/webview",
    sourcemap: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "webview",
      cssFileName: "webview",
    },
    rollupOptions: {
      output: {
        entryFileNames: "webview.js",
        assetFileNames: (asset) => (asset.names.includes("webview.css") ? "webview.css" : "[name][extname]"),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
