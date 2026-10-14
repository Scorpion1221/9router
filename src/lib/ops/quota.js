// Quota for one connection, through the same refresh + provider-usage path as
// the dashboard's Quota Tracker, normalized server-side to { name, remaining%,
// resetAt } rows. Raw provider payloads are not returned (they can echo account
// identifiers), only the normalized rows plus plan/message text.
import "open-sse/index.js";
import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { parseQuotaData, getRemainingPercentage } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { redactSecrets } from "./redact.js";

function toIso(value) {
  if (!value) return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function supportsQuota(conn) {
  if (!conn || !USAGE_SUPPORTED_PROVIDERS.includes(conn.provider)) return false;
  const authType = String(conn.authType || "").replace(/_/g, "");
  return authType === "oauth" || (authType === "apikey" && USAGE_APIKEY_PROVIDERS.includes(conn.provider));
}

export async function getConnectionQuota(connectionId, { force = false } = {}) {
  let conn = await getProviderConnectionById(connectionId);
  if (!conn) return null;
  if (!supportsQuota(conn)) return { supported: false, rows: [], message: `quota not available for ${conn.provider}/${conn.authType}` };

  const proxyConfig = await resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };
  if (conn.authType === "oauth") {
    try {
      conn = (await refreshAndUpdateCredentials(conn, false, proxyOptions)).connection;
    } catch (e) {
      return { supported: true, rows: [], message: `credential refresh failed: ${redactSecrets(e?.message || e, 160)}` };
    }
  }
  const usage = await getUsageForProvider(conn, proxyOptions, { force });
  // Feeds the routing quota state too (and can lift a lock the reading disproves).
  const { applyQuotaReading } = await import("@/sse/services/quotaPoller.js");
  await applyQuotaReading(conn, usage).catch(() => {});
  const rows = parseQuotaData(conn.provider, usage)
    .filter((q) => q?.name && q.name !== "error")
    .map((q) => ({
      name: q.name,
      remainingPct: getRemainingPercentage(q),
      resetAt: toIso(q.resetAt),
    }));
  return {
    supported: true,
    plan: typeof usage?.plan === "string" ? usage.plan : null,
    message: typeof usage?.message === "string" ? redactSecrets(usage.message) : null,
    rows,
  };
}
