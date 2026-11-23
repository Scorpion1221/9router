import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { parseAntigravityEnterpriseBundle } from "@/lib/oauth/utils/antigravityEnterpriseCredentials";
import { refreshGoogleToken } from "open-sse/services/tokenRefresh.js";
import { fetchAntigravityEnterpriseConfig } from "open-sse/executors/antigravity-enterprise.js";

const PROVIDER_ID = "antigravity-enterprise";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/**
 * POST /api/oauth/antigravity-enterprise/import
 * Body: { bundle: <JSON from "Read from this Mac"> }. Works on any host; on the Mac
 * itself the dashboard fills the bundle via the local-only /local-read route first.
 *
 * The bundle's OAuth client + refresh token are validated against Google and Business
 * AI Code, then stored on the connection (providerSpecificData.clientId/clientSecret,
 * refreshToken). Nothing is returned except non-secret connection info.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

    let bundle;
    try {
      bundle = parseAntigravityEnterpriseBundle(body?.bundle);
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    const refreshed = await refreshGoogleToken(bundle.refreshToken, bundle.clientId, bundle.clientSecret, console);
    if (!refreshed?.accessToken) {
      return NextResponse.json(
        { error: "Google rejected this login (client or refresh token). Read it again from the Antigravity app." },
        { status: 401 },
      );
    }
    const accessToken = refreshed.accessToken;
    const expiresIn = refreshed.expiresIn;
    const refreshToken = refreshed.refreshToken || bundle.refreshToken;

    const providerSpecificData = {
      authMethod: "imported",
      clientId: bundle.clientId,
      clientSecret: bundle.clientSecret,
      userTier: bundle.userTier,
      tierDisplayName: bundle.tierDisplayName || "",
      region: bundle.region || "global",
      projectId: bundle.projectId,
    };

    let models = [];
    try {
      ({ models } = await fetchAntigravityEnterpriseConfig({ accessToken, projectId: bundle.projectId, providerSpecificData }));
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: err.status === 403 ? 403 : 502 });
    }

    let email = null;
    try {
      const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.ok) email = (await res.json())?.email || null;
    } catch {}

    const tierLabel = bundle.tierDisplayName || bundle.userTier;
    const connection = await createProviderConnection({
      provider: PROVIDER_ID,
      authType: "oauth",
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString(),
      email,
      displayName: email ? `${email} (${tierLabel})` : undefined,
      projectId: bundle.projectId,
      providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        projectId: bundle.projectId,
        tier: tierLabel,
        modelCount: models.length,
      },
    });
  } catch (error) {
    console.log("Antigravity Enterprise import error:", error?.message);
    return NextResponse.json({ error: error.message || "Import failed" }, { status: 500 });
  }
}
