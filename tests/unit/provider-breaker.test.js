import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveFailurePolicy, recordProviderFailure, recordProviderSuccess, breakerGate, resetProviderBreakers,
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
