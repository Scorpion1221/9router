import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];

  // 1. OpenRouter cache — preferred source of truth for live pricing.
  //    OR rows are vendor-published and refreshed every 24h, so they beat
  //    any static snapshot we'd hand-maintain in code.
  try {
    const { lookupModelMetadata } = await import("open-sse/services/openrouterSync.js");
    const or = await lookupModelMetadata(provider, model);
    if (or) {
      const out = {};
      if (or.inputPrice != null) out.input = or.inputPrice;
      if (or.outputPrice != null) out.output = or.outputPrice;
      if (or.cachedPrice != null) out.cached = or.cachedPrice;
      if (or.cacheWritePrice != null) out.cache_creation = or.cacheWritePrice;
      if (or.reasoningPrice != null) out.reasoning = or.reasoningPrice;
      if (Object.keys(out).length) {
        out._source = "openrouter";
        out._sourceModelId = or.id;
        return out;
      }
    }
  } catch { /* cache miss / cold boot — fall through to offline fallback */ }

  // 2. Offline fallback — hand-maintained provider pricing snapshot. Pattern
  //    hits are wildcard guesses; annotate them so callers don't treat them as
  //    authoritative.
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  const fromConst = resolveConst(provider, model);
  if (fromConst) {
    const isPatternGuess = fromConst._matchType === "pattern";
    if (isPatternGuess) {
      const { _matchType, _matchedPattern, ...clean } = fromConst;
      return { ...clean, _source: "pattern-guess", _matchedPattern };
    }
    return { ...fromConst, _source: "static-fallback" };
  }
  return null;
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
