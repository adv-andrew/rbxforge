import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/*.electron.spec.ts", "**/*.visual.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: "test-results/playwright",
  reporter: [["list"]],
  snapshotPathTemplate: "{testDir}/visual/__screenshots__/{arg}{ext}",
  tsconfig: "./tsconfig.playwright.json",
});
