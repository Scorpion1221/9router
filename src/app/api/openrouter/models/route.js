// Read-only catalog endpoint: GET /api/openrouter/models?provider=<id>
//
// Returns the OpenRouter-cached models that belong to `provider` (e.g. all
// anthropic/* rows when provider=cc or provider=claude). Used by the
// dashboard to show OR-detected models alongside the static PROVIDER_MODELS
// list, so brand-new vendor releases (e.g. claude-opus-4-8 the day Anthropic
// announces it) appear in the picker within 24h without a redeploy.
//
// Auth: relies on the global middleware (same as other /api/* endpoints).
// Returns: { provider, vendor, models: [{ id, name, contextWindow, maxOutput,
//   inputPrice, outputPrice, cachedPrice, cacheWritePrice, source: "openrouter",
//   pricingModelId }], fetchedAt, count }
//
// Provider → OpenRouter-vendor mapping uses the same VENDOR_PREFERENCE table
// as openrouterSync's matcher to stay consistent. If a provider isn't mapped
// (e.g. niche aggregators), we return an empty list rather than guessing.

import { NextResponse } from "next/server";
import { getAllModelMetadata, getModelMetadataMeta } from "@/lib/db/repos/modelMetadataRepo";

// Mirrors VENDOR_PREFERENCE in open-sse/services/openrouterSync.js.
// Source of truth: that file. Keep them in sync if you add providers.
const PROVIDER_TO_OR_VENDORS = {
  claude: ["anthropic"],
  cc: ["anthropic"],
  "claude-code": ["anthropic"],
  anthropic: ["anthropic"],
  openai: ["openai"],
  codex: ["openai"],
  cx: ["openai"],
  gemini: ["google"],
  "gemini-cli": ["google"],
  gc: ["google"],
  vertex: ["google"],
  vx: ["google"],
  antigravity: ["google"],
  ag: ["google"],
  xai: ["x-ai"],
  "grok-web": ["x-ai"],
  gw: ["x-ai"],
  deepseek: ["deepseek"],
  kimi: ["moonshotai"],
  qwen: ["qwen"],
  qw: ["qwen"],
};

// Vendor-specific naming conventions: OR stores ids the way OpenRouter routes
// them, but the actual upstream API often uses a different separator. We
// normalize to the form the upstream actually accepts, so the dashboard's
// copy-to-clipboard id can be pasted straight into a request and work.
//
//   Anthropic upstream: claude-opus-4-8         (dashes between digits)
//   OpenRouter id:      anthropic/claude-opus-4.8  (dot)
//
//   Google upstream:    gemini-2.5-pro          (dots already)
//   OpenRouter id:      google/gemini-2.5-pro   (dot)
//
// If we ever add a vendor that has yet another convention, add it here.
function canonicalizeBase(vendor, base) {
  if (vendor === "anthropic") {
    // Replace dots between digits with dashes: 4.8 → 4-8, 3.5 → 3-5.
    // Leave alpha-adjacent dots alone (none exist in current Anthropic ids,
    // but be defensive).
    return base.replace(/(\d)\.(\d)/g, "$1-$2");
  }
  return base;
}

// Strip OR-only marketing suffixes that we don't expose as separate models
// to the dashboard. The "-fast" variant on Anthropic rows is a different
// upstream endpoint, not a model — pricing is different but the model id is
// the same. Keeping it would surface confusing duplicates.
function shouldExposeModel(base) {
  if (/-fast$/.test(base)) return false;
  return true;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const provider = (searchParams.get("provider") || "").trim().toLowerCase();
  if (!provider) {
    return NextResponse.json({ error: "missing ?provider=" }, { status: 400 });
  }

  const vendors = PROVIDER_TO_OR_VENDORS[provider];
  if (!vendors || vendors.length === 0) {
    // Not an error — just no OR mapping for this provider.
    return NextResponse.json({
      provider,
      vendor: null,
      models: [],
      count: 0,
      note: "No OpenRouter vendor mapping for this provider",
    });
  }

  let all;
  let meta;
  try {
    [all, meta] = await Promise.all([
      getAllModelMetadata(),
      getModelMetadataMeta(),
    ]);
  } catch (err) {
    // OR sync hasn't run yet, or db unavailable. Soft-fail with empty list so
    // the dashboard falls back to the static catalog gracefully.
    return NextResponse.json({
      provider,
      vendor: vendors[0],
      models: [],
      count: 0,
      error: `OpenRouter cache unavailable: ${err.message}`,
    });
  }

  const vendorSet = new Set(vendors);
  const seen = new Set(); // dedup post-canonicalization (e.g. 4-7 vs 4.7)
  const models = [];
  for (const orId of Object.keys(all)) {
    const e = all[orId];
    if (!e || !vendorSet.has(e.vendor)) continue;
    if (!shouldExposeModel(e.base)) continue;
    const canonical = canonicalizeBase(e.vendor, e.base);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    models.push({
      // Use the canonical (vendor-API-accepting) form as the visible id, so
      // it dedups cleanly against PROVIDER_MODELS (which already uses dashes
      // for Anthropic) and so users can paste it into requests directly.
      id: canonical,
      name: e.name,
      contextWindow: e.contextWindow,
      maxOutput: e.maxOutput,
      inputPrice: e.inputPrice,
      outputPrice: e.outputPrice,
      cachedPrice: e.cachedPrice,
      cacheWritePrice: e.cacheWritePrice,
      reasoningPrice: e.reasoningPrice,
      source: "openrouter",
      pricingModelId: e.id,
      // Original OR base preserved so callers that need the OR-routed form
      // (e.g. price lookups via OpenRouter) can still find it.
      orBase: e.base,
    });
  }

  // Sort: newer-looking versions first (descending base id) so the picker
  // shows claude-opus-4.7 above claude-opus-4.5 etc. Falls back to alpha.
  models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));

  return NextResponse.json({
    provider,
    vendor: vendors[0],
    models,
    count: models.length,
    fetchedAt: meta?.fetchedAt || null,
  });
}
