export const DESKTOP_FIXTURE_LAUNCH_ARGUMENT = "--rbxforge-visual-state";

const TEST_ONLY_ENTRY_NAME = /^(?:fixture-main|visual-fixtures|electron-fixture)(?:[._-]|$)/i;
const TEST_ONLY_PATH_COMPONENT = /^(?:test|tests|fixture|fixtures|test-results)$/i;

export function isTestOnlyDesktopPath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .some((segment) => TEST_ONLY_PATH_COMPONENT.test(segment) || TEST_ONLY_ENTRY_NAME.test(segment));
}

export function containsDesktopFixtureLaunchArgument(source) {
  return source.includes(DESKTOP_FIXTURE_LAUNCH_ARGUMENT);
}
