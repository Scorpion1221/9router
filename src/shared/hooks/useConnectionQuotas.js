"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseQuotaData,
  getQuotaCache,
  setQuotaCache,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Shares the Quota Tracker's localStorage cache, so switching between the two
// pages doesn't re-query. Only Claude's usage API is cached server-side, so a
// fresh-enough cached entry is shown instead of hitting the upstream again.
const FRESH_MS = 5 * 60 * 1000;
const MAX_CONCURRENT = 4;

export function supportsQuota(connection) {
  if (!connection || !USAGE_SUPPORTED_PROVIDERS.includes(connection.provider)) return false;
  const authType = String(connection.authType || "").replace(/_/g, "");
  return authType === "oauth" || (authType === "apikey" && USAGE_APIKEY_PROVIDERS.includes(connection.provider));
}

function isFresh(entry) {
  const at = Date.parse(entry?.cachedAt || "");
  return Number.isFinite(at) && Date.now() - at < FRESH_MS;
}

async function fetchQuotaEntry(connectionId, provider, force) {
  const res = await fetch(`/api/usage/${connectionId}${force ? "?force=1" : ""}`);
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 401) throw new Error(data.error || `HTTP ${res.status}`);
  const entry = res.ok
    ? { quotas: parseQuotaData(provider, data), plan: data.plan || null, message: data.message || null, raw: data }
    : { quotas: [], message: data.error || "Unauthorized" };
  setQuotaCache(connectionId, entry);
  return entry;
}

/**
 * Quota per connection for the given list: cached entries at once, stale or
 * missing ones fetched in the background (a few at a time).
 * @returns {{ quotas: Record<string, object>, loading: Record<string, boolean>, errors: Record<string, string>, refresh: (id?: string) => void }}
 */
export default function useConnectionQuotas(connections) {
  const [quotas, setQuotas] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const inFlight = useRef(new Set());

  const eligible = (connections || []).filter(supportsQuota);
  const key = eligible.map((c) => c.id).join(",");

  const load = (targets, force) => {
    const queue = targets.filter((c) => !inFlight.current.has(c.id));
    if (!queue.length) return;
    queue.forEach((c) => inFlight.current.add(c.id));
    setLoading((prev) => ({ ...prev, ...Object.fromEntries(queue.map((c) => [c.id, true])) }));
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          const entry = await fetchQuotaEntry(c.id, c.provider, force);
          if (entry) setQuotas((prev) => ({ ...prev, [c.id]: entry }));
          setErrors((prev) => ({ ...prev, [c.id]: null }));
        } catch (e) {
          setErrors((prev) => ({ ...prev, [c.id]: e.message || "Failed to load quota" }));
        } finally {
          inFlight.current.delete(c.id);
          setLoading((prev) => ({ ...prev, [c.id]: false }));
        }
      }
    };
    for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) worker();
  };

  useEffect(() => {
    if (!eligible.length) return;
    const cache = getQuotaCache();
    const cached = {};
    const stale = [];
    for (const c of eligible) {
      if (cache[c.id]) cached[c.id] = cache[c.id];
      if (!isFresh(cache[c.id])) stale.push(c);
    }
    // Sync from an external store (localStorage), then fetch what is stale.
    setQuotas((prev) => ({ ...cached, ...prev }));
    load(stale, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = (id) => {
    const targets = id ? eligible.filter((c) => c.id === id) : eligible;
    load(targets, true);
  };

  return { quotas, loading, errors, refresh };
}
