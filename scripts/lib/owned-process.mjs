const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_GRACEFUL_ATTEMPTS = 80;
const DEFAULT_FORCED_ATTEMPTS = 120;

export async function ensureOwnedProcessGone(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Owned process PID must be a positive integer, received ${String(pid)}`);
  }
  const probe = options.probe ?? probePid;
  const force = options.force ?? forcePid;
  const delay =
    options.delay ?? (() => new Promise((resolveDelay) => setTimeout(resolveDelay, DEFAULT_POLL_INTERVAL_MS)));
  const gracefulAttempts = positiveAttempts(options.gracefulAttempts ?? DEFAULT_GRACEFUL_ATTEMPTS, "gracefulAttempts");
  const forcedAttempts = positiveAttempts(options.forcedAttempts ?? DEFAULT_FORCED_ATTEMPTS, "forcedAttempts");

  if (await waitUntilGone(pid, gracefulAttempts, probe, delay)) return;
  try {
    force(pid, "SIGKILL");
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    throw error;
  }
  if (await waitUntilGone(pid, forcedAttempts, probe, delay)) return;
  throw new Error(`Owned process PID ${pid} remained alive after bounded SIGKILL cleanup`);
}

async function waitUntilGone(pid, attempts, probe, delay) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!probe(pid)) return true;
    if (attempt + 1 < attempts) await delay();
  }
  return false;
}

function probePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

function forcePid(pid, signal) {
  process.kill(pid, signal);
}

function positiveAttempts(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function isNoSuchProcess(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
