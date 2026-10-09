// Drain-friendly process lifecycle.
//
// On SIGTERM/SIGINT, Next's start-server stops accepting connections, waits for
// in-flight requests (an LLM stream can run for minutes) and then exits. Code here
// must not exit on the signal itself, or every open stream is cut mid-response.
// Another signal while draining (after the duplicate window below) forces the exit,
// e.g. Ctrl+C pressed twice; `docker stop` sends one SIGTERM and SIGKILLs only
// after its timeout.
//
// - onDrain(fn): runs once when draining starts, e.g. to end dashboard SSE streams
//   that never finish on their own and would hold the drain open, or to stop
//   background jobs. Must not keep the process alive.
// - onProcessExit(fn): synchronous cleanup run once on the way out (flush DB, kill
//   child processes). Runs on "exit", so it also covers process.exit() from
//   anywhere, including Next's own exit after its drain.
//
// State lives on global: Next bundles this module into several chunks.

// A second signal this soon after the first is the same stop request delivered
// twice (Ctrl+C reaches both npm and node; npm also forwards it) — not a demand to
// abandon the drain. Next ignores duplicates for the same reason.
const DUPLICATE_SIGNAL_MS = 2000;

const state = global.__9rShutdown ??= {
  draining: false,
  drainStartedAt: 0,
  drainHandlers: new Set(),
  exitHandlers: new Set(),
  installed: false,
};

function runAll(handlers, label) {
  for (const fn of handlers) {
    try {
      fn();
    } catch (e) {
      console.error(`[Shutdown] ${label} handler failed:`, e?.message ?? e);
    }
  }
}

function install() {
  if (state.installed) return;
  state.installed = true;

  const onStop = (signal, listener) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (state.draining) {
      if (Date.now() - state.drainStartedAt < DUPLICATE_SIGNAL_MS) return;
      console.log(`[Shutdown] ${signal} again: exiting without waiting for in-flight requests`);
      process.exit(code);
    }
    state.draining = true;
    state.drainStartedAt = Date.now();
    console.log(`[Shutdown] ${signal}: draining — finishing in-flight requests, then exiting`);
    runAll(state.drainHandlers, "drain");
    // Merely listening disables Node's default exit-on-signal. When nothing else
    // will end the process (no Next server, e.g. a script or test), keep it.
    if (process.listeners(signal).every((l) => l === listener)) process.exit(code);
  };
  const onTerm = () => onStop("SIGTERM", onTerm);
  const onInt = () => onStop("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  process.once("exit", () => runAll(state.exitHandlers, "exit"));
}

export function isDraining() {
  return state.draining;
}

export function onDrain(fn) {
  install();
  state.drainHandlers.add(fn);
  if (state.draining) fn();
  return () => state.drainHandlers.delete(fn);
}

export function onProcessExit(fn) {
  install();
  state.exitHandlers.add(fn);
  return () => state.exitHandlers.delete(fn);
}
