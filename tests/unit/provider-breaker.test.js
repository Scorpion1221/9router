import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveFailurePolicy, recordProviderFailure, recordProviderSuccess, breakerGate, resetProviderBreakers, dropServerTools,
} from "../../open-sse/services/providerBreaker.js";

const P = "anthropic-compatible-gw";
const policy = (over = {}) => resolveFailurePolicy({ providerStrategies: { [P]: { noLockOnTimeout: true, breaker: { enabled: true, threshold: 3, windowSec: 60, cooldownSec: 30, ...over } } } }, P);

beforeEach(() => resetProviderBreakers());

describe("resolveFailurePolicy", () => {
  it("is off by default", () => {
    const p = resolveFailurePolicy({}, P);
    expect(p.noLockOnTimeout).toBe(false);
    expect(p.breaker.enabled).toBe(false);
  });

  it("reads the per-provider switches and clamps bad numbers to defaults", () => {
    const p = resolveFailurePolicy({ providerStrategies: { [P]: { noLockOnTimeout: true, breaker: { enabled: true, threshold: -1, windowSec: "x", cooldownSec: 45 } } } }, P);
    expect(p.noLockOnTimeout).toBe(true);
    expect(p.breaker).toMatchObject({ enabled: true, threshold: 3, windowMs: 60_000, cooldownMs: 45_000 });
  });

  it("does not leak one provider's policy to another", () => {
    expect(resolveFailurePolicy({ providerStrategies: { [P]: { noLockOnTimeout: true } } }, "claude").noLockOnTimeout).toBe(false);
  });
});

describe("provider breaker", () => {
  it("opens after `threshold` failures inside the window", () => {
    const pol = policy();
    const t = 1_000_000;
    expect(recordProviderFailure(P, pol, t)).toBe(false);
    expect(recordProviderFailure(P, pol, t + 1000)).toBe(false);
    expect(recordProviderFailure(P, pol, t + 2000)).toBe(true);
    expect(breakerGate(P, pol, t + 3000)).toMatchObject({ open: true });
  });

  it("forgets failures older than the window", () => {
    const pol = policy();
    const t = 1_000_000;
    recordProviderFailure(P, pol, t);
    recordProviderFailure(P, pol, t + 1000);
    expect(recordProviderFailure(P, pol, t + 61_001)).toBe(false);
    expect(breakerGate(P, pol, t + 61_002).open).toBe(false);
  });

  it("a success clears the count", () => {
    const pol = policy();
    const t = 1_000_000;
    recordProviderFailure(P, pol, t);
    recordProviderFailure(P, pol, t + 1000);
    recordProviderSuccess(P);
    expect(recordProviderFailure(P, pol, t + 2000)).toBe(false);
  });

  it("after the cooldown lets exactly one probe through, then closes on success", () => {
    const pol = policy();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) recordProviderFailure(P, pol, t + i);
    expect(breakerGate(P, pol, t + 29_000).open).toBe(true);
    expect(breakerGate(P, pol, t + 31_000)).toMatchObject({ open: false, probe: true });
    expect(breakerGate(P, pol, t + 31_500).open).toBe(true);
    recordProviderSuccess(P);
    expect(breakerGate(P, pol, t + 32_000)).toMatchObject({ open: false, probe: false });
  });

  it("a failed probe reopens for another cooldown", () => {
    const pol = policy();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) recordProviderFailure(P, pol, t + i);
    breakerGate(P, pol, t + 31_000);
    expect(recordProviderFailure(P, pol, t + 40_000)).toBe(true);
    expect(breakerGate(P, pol, t + 60_000).open).toBe(true);
    expect(breakerGate(P, pol, t + 71_000)).toMatchObject({ open: false, probe: true });
  });

  it("an abandoned probe does not wedge the breaker", () => {
    const pol = policy();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) recordProviderFailure(P, pol, t + i);
    breakerGate(P, pol, t + 31_000);
    expect(breakerGate(P, pol, t + 31_000 + 30_001)).toMatchObject({ open: false, probe: true });
  });

  it("does nothing when the breaker is disabled", () => {
    const pol = resolveFailurePolicy({}, P);
    for (let i = 0; i < 10; i++) expect(recordProviderFailure(P, pol, 1_000 + i)).toBe(false);
    expect(breakerGate(P, pol, 2_000).open).toBe(false);
  });
});

describe("noServerTools", () => {
  const ws = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
  const wf = { type: "web_fetch_20260209", name: "web_fetch" };
  const ce = { type: "code_execution_20260521", name: "code_execution" };
  const ts = { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" };
  const bash = { name: "Bash", input_schema: { type: "object" } };

  it("is off by default and read per provider", () => {
    expect(resolveFailurePolicy({}, P).noServerTools).toBe(false);
    expect(resolveFailurePolicy({ providerStrategies: { [P]: { noServerTools: true } } }, P).noServerTools).toBe(true);
  });

  it("rejects a request whose only tools are server tools (Claude Code WebSearch sub-call)", () => {
    expect(dropServerTools({ tools: [ws] })).toMatchObject({ reject: true, dropped: ["web_search"] });
    expect(dropServerTools({ tools: [{ ...ws, type: "web_search_20260209" }, wf] })).toMatchObject({ reject: true, dropped: ["web_search", "web_fetch"] });
  });

  it("drops server tools next to other tools without touching the caller's body", () => {
    const body = { tools: [bash, ws, ce], tool_choice: { type: "tool", name: "web_search" } };
    const out = dropServerTools(body);
    expect(out.reject).toBe(false);
    expect(out.dropped).toEqual(["web_search", "code_execution"]);
    expect(out.body.tools).toEqual([bash]);
    expect(out.body.tool_choice).toBeUndefined();
    expect(body.tools).toHaveLength(3);
  });

  it("keeps tools Bedrock supports (tool search, client tools) and a forced choice on a kept tool", () => {
    const out = dropServerTools({ tools: [bash, ts, ws], tool_choice: { type: "tool", name: "Bash" } });
    expect(out.body.tools).toEqual([bash, ts]);
    expect(out.body.tool_choice).toEqual({ type: "tool", name: "Bash" });
  });

  it("drops mcp_servers together with its mcp_toolset", () => {
    const out = dropServerTools({ tools: [bash, { type: "mcp_toolset", mcp_server_name: "x" }], mcp_servers: [{ type: "url", url: "https://x", name: "x" }] });
    expect(out.body.tools).toEqual([bash]);
    expect(out.body.mcp_servers).toBeUndefined();
  });

  it("leaves requests without server tools alone", () => {
    const body = { tools: [bash, ts] };
    expect(dropServerTools(body)).toEqual({ reject: false, dropped: [], body });
    expect(dropServerTools({}).reject).toBe(false);
  });
});
