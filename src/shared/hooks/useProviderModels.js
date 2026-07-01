// useProviderModels — shared "what models does this provider expose?" hook.
//
// Single source of truth for the dashboard's model picker, the per-provider
// page's Available Models grid, the combo Add-Model modal, and anywhere else
// that lists models for a given provider id. Replaces the ad-hoc
// `[...PROVIDER_MODELS[alias], ...kiloFreeModels, ...orModels]` union that
// was duplicated across pages and produced subtle bugs:
//
//   - duplicate cards when a static dated-snapshot id (claude-opus-4-5-20251101)
//     and the OR latest pointer (claude-opus-4-5) refer to the same family.
//   - OR-detected models showing up in /dashboard/providers/[id] but missing
//     from the combo "Add Model" modal because each page wired OR in itself.
//   - Static entries silently winning over fresher OR data when the ids
//     happened to be string-equal.
//
// Two call shapes:
//
//   useProviderModels(providerId)             → { models, loading, error }
//   useProviderModels([id1, id2, ...])        → { byProvider: { id1: [...], ... }, loading, error }
//
// The multi-provider form is for screens that list models across all connected
// providers (e.g. the combo Add-Model modal). It batches OR fetches into one
// request per provider but reuses the same family-dedup logic.
//
// Resolution rules per provider (in order):
//   1. Build candidates = static PROVIDER_MODELS[alias] ∪ kiloFreeModels (kilocode only)
//      ∪ OR-detected models from /api/openrouter/models?provider=<id>.
//   2. Group by familyKey() — collapses dated snapshots into their latest
//      pointer family (claude-opus-4-5-20251101 → claude-opus-4-5).
//   3. Within a family, prefer in order: OR (live truth) > static > kilo.
//      OR data carries ctx/pricing metadata the others lack.
//
// Returned shape per model:
//   { id, name, type?, contextWindow?, maxOutput?,
//     inputPrice?, outputPrice?, source: 'openrouter'|'static'|'kilo' }
//
// Usage:
//   const { models } = useProviderModels("claude");
//   const { byProvider } = useProviderModels(["claude", "openai", "gemini"]);

import { useEffect, useMemo, useState } from "react";
import { getModelsByProviderId } from "@/shared/constants/models";

// Reduce a model id to its "family" — i.e. ignore dated-snapshot suffixes so
// claude-opus-4-5-20251101 and claude-opus-4-5 collapse to the same group.
// Anthropic uses -YYYYMMDD; other vendors don't, so the regex is conservative.
function familyKey(id) {
  if (!id) return id;
  return id.replace(/-\d{8}$/, "");
}

// Pure merge — used by both the single- and multi-provider hooks.
// Inputs are arrays from each source; output is the deduped union.
function mergeModels(providerId, kiloModels, orModelsList) {
  if (!providerId) return [];
  const staticModels = (getModelsByProviderId(providerId) || []).map((m) => ({
    ...m,
    source: "static",
  }));
  const kilo = (kiloModels || []).map((m) => ({ ...m, source: "kilo" }));
  const or = (orModelsList || []).map((m) => ({
    ...m,
    type: m.type || "llm",
    source: "openrouter",
  }));

  // Family-keyed merge. Insert in priority order so the first writer wins:
  // OR > static > kilo.
  const families = new Map();
  const addByFamily = (entry) => {
    const key = familyKey(entry.id);
    if (families.has(key)) return;
    families.set(key, entry);
  };
  or.forEach(addByFamily);
  staticModels.forEach(addByFamily);
  kilo.forEach(addByFamily);
  return [...families.values()];
}

function applyKindFilter(models, kindFilter) {
  if (!kindFilter) return models;
  return models.filter((m) => {
    const t = m.kind || m.type || "llm";
    return kindFilter === "llm" ? t === "llm" : t === kindFilter;
  });
}

export function useProviderModels(providerIdOrIds, { kindFilter } = {}) {
  // Normalize to array internally; remember whether caller wanted single shape.
  const isArray = Array.isArray(providerIdOrIds);
  const providerIds = useMemo(() => {
    if (isArray) return providerIdOrIds.filter(Boolean);
    return providerIdOrIds ? [providerIdOrIds] : [];
  }, [isArray, providerIdOrIds]);
  // Stable string key so the deep-fetch effect doesn't refire on referentially
  // new arrays with identical contents (common when callers .map() each render).
  const providerIdsKey = providerIds.join("|");

  const [orByProvider, setOrByProvider] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [kiloModels, setKiloModels] = useState([]);

  // Fetch OR catalog for each requested provider. Each request is independent
  // and soft-fails — one provider's miss doesn't block the others.
  useEffect(() => {
    if (providerIds.length === 0) return;
    let cancelled = false;
    setLoading(true);
    Promise.all(
      providerIds.map((id) =>
        fetch(`/api/openrouter/models?provider=${encodeURIComponent(id)}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => [id, Array.isArray(data?.models) ? data.models : []])
          .catch(() => [id, []]),
      ),
    )
      .then((entries) => {
        if (cancelled) return;
        const next = {};
        for (const [id, models] of entries) next[id] = models;
        setOrByProvider(next);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  // providerIdsKey is the stable identity — refetch only when the set changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIdsKey]);

  // Kilo free models are only relevant if "kilocode" is in the requested set.
  useEffect(() => {
    if (!providerIds.includes("kilocode")) {
      setKiloModels([]);
      return;
    }
    let cancelled = false;
    fetch("/api/providers/kilo/free-models")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.models?.length) setKiloModels(data.models);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIdsKey]);

  const byProvider = useMemo(() => {
    const out = {};
    for (const id of providerIds) {
      const kilo = id === "kilocode" ? kiloModels : [];
      const merged = mergeModels(id, kilo, orByProvider[id]);
      out[id] = applyKindFilter(merged, kindFilter);
    }
    return out;
  }, [providerIds, kiloModels, orByProvider, kindFilter]);

  if (isArray) {
    return { byProvider, loading, error };
  }
  return {
    models: byProvider[providerIds[0]] || [],
    loading,
    error,
  };
}

