import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, defineProject } from "vitest/config";
import react from "@vitejs/plugin-react";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));

export const desktopTestProjects = [
  defineProject({
    root: desktopRoot,
    test: {
      name: "desktop-node",
      environment: "node",
      include: ["src/shared/**/*.test.ts", "src/main/**/*.test.ts", "src/preload/**/*.test.ts"],
    },
  }),
  defineProject({
    root: desktopRoot,
    plugins: [react()],
    test: {
      name: "desktop-renderer",
      environment: "jsdom",
      include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx"],
      css: { modules: { classNameStrategy: "non-scoped" } },
    },
  }),
  defineProject({
    root: desktopRoot,
    test: {
      name: "desktop-integration",
      environment: "node",
      include: ["tests/electron/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/visual/**/*.test.ts"],
    },
  }),
];

export default defineConfig({
  plugins: [react()],
  test: {
    name: "desktop",
    environment: "node",
    css: { modules: { classNameStrategy: "non-scoped" } },
    exclude: [...configDefaults.exclude, "tests/electron/**/*.spec.ts", "tests/visual/**/*.spec.ts"],
    projects: desktopTestProjects,
  },
});
