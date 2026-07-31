import { defineConfig } from "vitest/config";
import { desktopTestProjects } from "./apps/desktop/vitest.config.js";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "!apps/desktop", ...desktopTestProjects],
  },
});
