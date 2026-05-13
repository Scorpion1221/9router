// OpenRouter model catalog sync.
//
// Pulls https://openrouter.ai/api/v1/models on a schedule, normalizes each
// row into { id, vendor, base, name, contextWindow, maxOutput, inputPrice,
// outputPrice, cachedPrice, cacheWritePrice, reasoningPrice, imagePrice },
// and persists the result to the kv table via modelMetadataRepo.
//
// Reads go through a small in-memory matcher that:
//   1. exact match on internal modelId → OpenRouter `base` (part after slash)
//   2. fuzzy: strip routing suffixes ([1m], -vertex, -ddit, -partner)
//   3. fuzzy: strip date stamps (-YYYYMMDD)
//   4. fuzzy: swap `4-5` ↔ `4.5` style separators
//
// Empirically this matches ~87% of upstream LiteLLM/NewAPI model IDs
// to OpenRouter rows.

import {
  getAllModelMetadata,
  getModelMetadataMeta,
  replaceAllModelMetadata,
} from "../../src/lib/db/repos/modelMetadataRepo.js";

const ENDPOINT = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

// ──────────────────────────────────────────────────────────────────────────
// Normalization
// ──────────────────────────────────────────────────────────────────────────

function priceToPerMillion(s) {
  if (s == null || s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000).toFixed(4));
}

function normalizeRow(m) {
  const orId = m?.id;
  if (!orId || typeof orId !== "string") return null;
  const slash = orId.indexOf("/");
  const vendor = slash > 0 ? orId.slice(0, slash) : "";
  const base = slash > 0 ? orId.slice(slash + 1) : orId;
  const p = m.pricing || {};
  const tp = m.top_provider || {};
  return {
    id: orId,
    vendor,
    base: base.toLowerCase(),
    name: m.name || orId,
    contextWindow: m.context_length || tp.context_length || null,
    maxOutput: tp.max_completion_tokens || null,
    inputPrice: priceToPerMillion(p.prompt),
    outputPrice: priceToPerMillion(p.completion),
    cachedPrice: priceToPerMillion(p.input_cache_read),
    cacheWritePrice: priceToPerMillion(p.input_cache_write),
    reasoningPrice: priceToPerMillion(p.internal_reasoning),
    imagePrice: priceToPerMillion(p.image),
    webSearchPrice: priceToPerMillion(p.web_search),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Fetch + persist
// ──────────────────────────────────────────────────────────────────────────

export async function fetchOpenRouterModels({ log } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { signal: controller.signal });
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    const normalized = rows.map(normalizeRow).filter(Boolean);
    log?.info?.("OR_SYNC", `Fetched ${normalized.length} models from OpenRouter`);
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncOpenRouterModels({ log } = {}) {
  const entries = await fetchOpenRouterModels({ log });
  const result = await replaceAllModelMetadata(entries, "openrouter");
  // bust the in-memory index so next lookup re-reads from db
  _cache = null;
  log?.info?.("OR_SYNC", `Persisted ${result.count} model metadata entries`);
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory matcher
// ──────────────────────────────────────────────────────────────────────────

let _cache = null; // { byBase: Map<base, entry[]>, byId: Map<id, entry> }

async function getIndex() {
  if (_cache) return _cache;
  const all = await getAllModelMetadata();
  const byBase = new Map();
  const byId = new Map();
  for (const orId of Object.keys(all)) {
    const e = all[orId];
    if (!e) continue;
    byId.set(orId, e);
    const arr = byBase.get(e.base) || [];
    arr.push(e);
    byBase.set(e.base, arr);
  }
  _cache = { byBase, byId };
  return _cache;
}

/**
 * Bust in-memory index. Useful for tests or after manual db mutations.
 */
export function invalidateCache() { _cache = null; }

// Vendor preference when multiple OpenRouter rows share the same base name.
// Maps our internal provider id → preferred OpenRouter vendor prefix(es).
const VENDOR_PREFERENCE = {
  claude: ["anthropic"],
  "claude-code": ["anthropic"],
  openai: ["openai"],
  codex: ["openai"],
  gemini: ["google"],
  "gemini-cli": ["google"],
  vertex: ["google"],
  antigravity: ["google"],
  xai: ["x-ai"],
  "grok-web": ["x-ai"],
  deepseek: ["deepseek"],
  kimi: ["moonshotai"],
  qwen: ["qwen"],
};

function stripRoutingSuffix(modelId) {
  // Strip our routing variants: [1m], -vertex, -ddit, -partner
  // plus codex/9router-internal effort/mode variants that OpenRouter doesn't know about.
  //
  // IMPORTANT: only effort/mode tokens go in VARIANT_SUFFIXES — never base-model
  // name fragments like "codex" or "mini" on their own (they're part of the
  // canonical model id). The ".-review" tail is its own token; combining it
  // with effort like "-xhigh-review" needs a single entry only when stripping
  // both at once is shorter than two passes (it isn't — the loop handles it).
  let s = modelId.toLowerCase();
  s = s.replace(/\[[^\]]*\]/g, "");
  s = s.replace(/-(vertex|partner|ddit)$/g, "");
  // Effort/mode tokens. Apply repeatedly (longest-first within each pass) so
  // combos like "-mini-high-review" peel as "-review" then "-mini-high".
  const VARIANT_SUFFIXES = [
    "-mini-high", "-xhigh", "-high", "-low", "-none", "-spark",
    "-review", "-image",
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of VARIANT_SUFFIXES) {
      if (s.endsWith(suf)) { s = s.slice(0, -suf.length); changed = true; break; }
    }
  }
  return s;
}

function stripDateStamp(s) {
  // Strip -YYYYMMDD suffix (used by anthropic for dated snapshots)
  return s.replace(/-\d{8}$/, "");
}

function dashDotSwaps(s) {
  // Generate variants with 4-5 ↔ 4.5 between digits
  const variants = new Set([s]);
  variants.add(s.replace(/(\d)-(\d)/g, "$1.$2"));
  variants.add(s.replace(/(\d)\.(\d)/g, "$1-$2"));
  return [...variants];
}

/**
 * Find OpenRouter metadata for a (providerId, modelId) pair.
 * Returns the normalized entry, or null if no match.
 */
export async function lookupModelMetadata(providerId, modelId) {
  if (!modelId) return null;
  const { byBase, byId } = await getIndex();
  if (byId.size === 0) return null;

  // First try direct OpenRouter id (e.g. user already passed "anthropic/claude-…")
  if (modelId.includes("/")) {
    const exact = byId.get(modelId);
    if (exact) return exact;
  }

  // Build candidate base strings to probe against OpenRouter's `base` column.
  const probes = new Set();
  const raw = modelId.toLowerCase();
  probes.add(raw);
  for (const v of dashDotSwaps(raw)) probes.add(v);

  const stripped = stripRoutingSuffix(modelId);
  if (stripped !== raw) {
    for (const v of dashDotSwaps(stripped)) probes.add(v);
  }
  const dateStripped = stripDateStamp(stripped);
  if (dateStripped !== stripped) {
    for (const v of dashDotSwaps(dateStripped)) probes.add(v);
  }

  // Vendor preference: try preferred vendor first when there are ties.
  const preferred = VENDOR_PREFERENCE[providerId] || [];

  for (const probe of probes) {
    const hits = byBase.get(probe);
    if (!hits || hits.length === 0) continue;
    if (hits.length === 1) return hits[0];
    if (preferred.length) {
      const pref = hits.find((h) => preferred.includes(h.vendor));
      if (pref) return pref;
    }
    return hits[0];
  }

  // Last-resort: scan for OR bases that *start with* one of our probes plus a
  // dash. Catches the case where OR carries a date-stamped variant (e.g.
  // "qwen3.5-plus-20260420") but the user's id has no date.
  for (const probe of probes) {
    const matches = [];
    for (const [base, hits] of byBase) {
      if (base.startsWith(probe + "-")) matches.push(...hits);
    }
    if (!matches.length) continue;
    if (preferred.length) {
      const pref = matches.find((h) => preferred.includes(h.vendor));
      if (pref) return pref;
    }
    return matches[0];
  }
  return null;
}

// ─────────────────────────────────────────────��────────────────────────────
// Background refresh
// ──────────────────────────────────────────────────────────────────────────

let _scheduler = null;

/**
 * Start the background refresh loop. Idempotent: calling twice has no effect.
 * On boot, if the cache is empty OR older than refreshIntervalMs, kicks off
 * an immediate sync. Then runs syncOpenRouterModels() every refreshIntervalMs.
 */
export function startOpenRouterSyncScheduler({ log, refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS } = {}) {
  if (_scheduler) return;
  _scheduler = { stopped: false };

  const run = async () => {
    if (_scheduler.stopped) return;
    try {
      await syncOpenRouterModels({ log });
    } catch (err) {
      log?.warn?.("OR_SYNC", `Refresh failed: ${err.message}`);
    }
  };

  // Initial sync — only if cache is stale or missing
  (async () => {
    try {
      const meta = await getModelMetadataMeta();
      const age = meta?.fetchedAt ? Date.now() - new Date(meta.fetchedAt).getTime() : Infinity;
      if (!meta || age > refreshIntervalMs) {
        log?.info?.("OR_SYNC", meta ? `Cache stale (${Math.round(age / 3600_000)}h), refreshing` : "No cache, fetching initial");
        await run();
      } else {
        log?.info?.("OR_SYNC", `Cache fresh (${meta.count} models, ${Math.round(age / 3600_000)}h old)`);
      }
    } catch (err) {
      log?.warn?.("OR_SYNC", `Initial sync check failed: ${err.message}`);
    }
  })();

  // Recurring schedule
  _scheduler.interval = setInterval(run, refreshIntervalMs);
  // Don't block process exit on this timer
  if (typeof _scheduler.interval.unref === "function") _scheduler.interval.unref();
}

export function stopOpenRouterSyncScheduler() {
  if (!_scheduler) return;
  _scheduler.stopped = true;
  if (_scheduler.interval) clearInterval(_scheduler.interval);
  _scheduler = null;
}
