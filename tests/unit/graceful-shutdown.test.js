/**
 * src/lib/shutdown.js — drain-friendly process shutdown.
 *
 * The rolling deploy relies on SIGTERM NOT ending the process while Next's
 * start-server drains in-flight requests (an LLM stream can run for minutes).
 * Each case runs in a child process so real signals and exits can be observed.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHUTDOWN_URL = pathToFileURL(path.resolve(here, "../../src/lib/shutdown.js")).href;

// Runs `body` as an ESM child with `shutdown` imported; returns { code, signal, out }.
function runChild(body, { signalAfterReady, signal = "SIGTERM", timeoutMs = 8000 } = {}) {
  const src = `import * as shutdown from ${JSON.stringify(SHUTDOWN_URL)};\n${body}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timed out:\n${out}`)); }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      if (signalAfterReady && out.includes("READY")) {
        signalAfterReady = false;
        child.kill(signal);
      }
    });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (code, sig) => { clearTimeout(timer); resolve({ code, signal: sig, out }); });
  });
}

describe("graceful shutdown coordinator", () => {
  it("keeps serving after SIGTERM while another owner (Next) handles the exit", async () => {
    // Simulates Next: its own SIGTERM listener finishes in-flight work later, then exits.
    const r = await runChild(`
      shutdown.onDrain(() => console.log("SIGNAL_HANDLER"));
      shutdown.onProcessExit(() => console.log("EXIT_HANDLER"));
      process.on("SIGTERM", () => setTimeout(() => { console.log("DRAINED"); process.exit(0); }, 300));
      setInterval(() => {}, 1000);
      console.log("READY");
    `, { signalAfterReady: true });

    expect(r.out).toContain("SIGNAL_HANDLER");
    // Drained before exit handlers ran: the coordinator did not exit on the signal.
    expect(r.out.indexOf("DRAINED")).toBeGreaterThan(r.out.indexOf("SIGNAL_HANDLER"));
    expect(r.out.indexOf("EXIT_HANDLER")).toBeGreaterThan(r.out.indexOf("DRAINED"));
    expect(r.code).toBe(0);
  });

  it("falls back to exiting when nothing else handles the signal", async () => {
    const r = await runChild(`
      shutdown.onProcessExit(() => console.log("EXIT_HANDLER"));
      setInterval(() => {}, 1000);
      console.log("READY");
    `, { signalAfterReady: true });

    expect(r.out).toContain("EXIT_HANDLER");
    expect(r.code).toBe(143);
  });

  it("runs exit handlers on a plain process.exit and isolates a failing one", async () => {
    const r = await runChild(`
      shutdown.onProcessExit(() => { throw new Error("boom"); });
      shutdown.onProcessExit(() => console.log("SECOND_RAN"));
      process.exit(0);
    `);

    expect(r.out).toContain("SECOND_RAN");
    expect(r.code).toBe(0);
  });

  it("runs a handler registered after draining began immediately", async () => {
    const r = await runChild(`
      shutdown.onDrain(() => {});
      process.on("SIGTERM", () => setTimeout(() => {
        console.log("DRAINING:" + shutdown.isDraining());
        shutdown.onDrain(() => console.log("LATE_HANDLER_RAN"));
        process.exit(0);
      }, 50));
      setInterval(() => {}, 1000);
      console.log("READY");
    `, { signalAfterReady: true });

    expect(r.out).toContain("DRAINING:true");
    expect(r.out).toContain("LATE_HANDLER_RAN");
  });

  it("ignores a duplicate signal right after the first (same stop request)", async () => {
    const r = await runChild(`
      shutdown.onDrain(() => setTimeout(() => process.kill(process.pid, "SIGTERM"), 50));
      process.on("SIGTERM", () => setTimeout(() => { console.log("DRAINED"); process.exit(0); }, 400));
      setInterval(() => {}, 1000);
      console.log("READY");
    `, { signalAfterReady: true });

    expect(r.out).toContain("DRAINED");
    expect(r.code).toBe(0);
  });

  it("a later second signal while draining forces the exit", async () => {
    const r = await runChild(`
      shutdown.onDrain(() => {
        console.log("DRAIN_STARTED");
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 2300);
      });
      shutdown.onProcessExit(() => console.log("EXIT_HANDLER"));
      process.on("SIGTERM", () => {}); // Next-like owner that would wait for the drain
      setInterval(() => {}, 1000);
      console.log("READY");
    `, { signalAfterReady: true });

    expect(r.out).toContain("DRAIN_STARTED");
    expect(r.out).toContain("EXIT_HANDLER");
    expect(r.code).toBe(143);
  });
});
