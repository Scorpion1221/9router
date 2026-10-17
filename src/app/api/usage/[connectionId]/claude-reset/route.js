// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { consumeClaudeResetGrant } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";
import { liftQuotaLockNow } from "@/sse/services/quotaPoller.js";
import { clearQuotaSnapshot } from "open-sse/services/quotaState.js";
import { hasUnsettledReset } from "@/lib/ops/resets.js";

// Spend one free Claude "limit reset" grant (irreversible)
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const { grantId } = await request.json().catch(() => ({}));

    let connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "claude" || connection.authType !== "oauth") {
      return Response.json({ error: "Limit reset is only available for Claude OAuth connections." }, { status: 400 });
    }

    // An ops (9r) attempt on this account got no definite answer: a new attempt here
    // would carry a fresh request id and could spend a second reset.
    if (await hasUnsettledReset(connection.id)) {
      return Response.json({ error: "A reset on this account is still unsettled (started from 9r). Finish it there, or wait 10 minutes and refresh." }, { status: 409 });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    const result = await consumeClaudeResetGrant(connection.accessToken, grantId, proxyOptions);

    if (result.ok) {
      // The refilled account is usable now, not when its old lock would have expired.
      clearQuotaSnapshot(connection.id);
      await liftQuotaLockNow(connection.id).catch((e) => console.warn(`[Claude Reset] lock clear failed: ${e.message}`));
      return Response.json(result);
    }
    if (result.uncertain) {
      // Maybe applied, maybe not: say so, so nobody clicks again on a stale count.
      return Response.json({ ...result, message: `Couldn't confirm whether the reset went through (${result.message || result.result || `HTTP ${result.status}`}). Refresh the quota before trying again.` }, { status: 502 });
    }
    const status = result.status >= 400 && result.status < 500 ? result.status : 409;
    return Response.json({ ...result, message: result.message || `Reset not applied: ${result.reason || result.result || "unknown"}` }, { status });
  } catch (error) {
    console.warn(`[Claude Reset] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
