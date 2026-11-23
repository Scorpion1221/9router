// Antigravity Enterprise (Business AI Code) quota: GET :fetchQuotaStatus.
// Response: { groups: [{ displayName, buckets: [{ bucketId, displayName, window,
//   resetTime, remainingFraction }] }], overageInfo }. The weekly bucket is the
// project's Gemini Enterprise base quota, shared by every seat on that project.
import { PROVIDERS } from "../../config/providers.js";
import { baicLocationPath } from "../../executors/antigravity-enterprise.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const WINDOW_SECONDS = { weekly: 7 * 24 * 3600, daily: 24 * 3600 };

/** Map a fetchQuotaStatus body to the shared usage shape (quotas keyed by window). */
export function parseAntigravityEnterpriseQuota(data, fetchedAt = Date.now()) {
  const quotas = {};
  for (const group of data?.groups || []) {
    for (const b of group?.buckets || []) {
      const frac = Number(b?.remainingFraction);
      if (!Number.isFinite(frac)) continue;
      const remaining = Math.max(0, Math.min(100, frac * 100));
      const name = b.window === "weekly" ? "weekly" : (b.bucketId || b.window || "quota");
      if (quotas[name]) continue;
      quotas[name] = {
        used: 100 - remaining,
        total: 100,
        remaining,
        resetAt: b.resetTime || null,
        windowSeconds: WINDOW_SECONDS[b.window] || null,
        unlimited: false,
        label: b.displayName || group.displayName || name,
      };
    }
  }
  return { quotas, fetchedAt };
}

export async function getAntigravityEnterpriseUsage(accessToken, providerSpecificData, projectId, proxyOptions = null) {
  if (!accessToken) return { message: "No access token" };
  const config = PROVIDERS["antigravity-enterprise"];
  const creds = { projectId, providerSpecificData };
  const userTier = providerSpecificData?.userTier;
  const qs = userTier ? `?${new URLSearchParams({ "entitlement.userTier": userTier })}` : "";
  try {
    const res = await proxyAwareFetch(`${config.baseUrl}/${baicLocationPath(creds)}:fetchQuotaStatus${qs}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": config.headers?.["User-Agent"] },
    }, proxyOptions);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
      return { message: `Quota status failed (HTTP ${res.status}): ${msg}` };
    }
    const parsed = parseAntigravityEnterpriseQuota(await res.json());
    if (!Object.keys(parsed.quotas).length) return { message: "No quota buckets returned" };
    return parsed;
  } catch (error) {
    return { message: `Quota status failed: ${error.message}` };
  }
}
