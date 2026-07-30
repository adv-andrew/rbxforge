import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "desktop",
    environment: "node",
    css: { modules: { classNameStrategy: "non-scoped" } },
    exclude: [...configDefaults.exclude, "tests/electron/**/*.spec.ts", "tests/visual/**/*.spec.ts"],
    projects: [
      {
        test: {
          name: "desktop-node",
          environment: "node",
          include: ["src/shared/**/*.test.ts", "src/main/**/*.test.ts", "src/preload/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "desktop-renderer",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx"],
          css: { modules: { classNameStrategy: "non-scoped" } },
        },
      },
      {
        test: {
          name: "desktop-integration",
          environment: "node",
          include: ["tests/electron/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/visual/**/*.test.ts"],
        },
      },
    ],
  },
});
