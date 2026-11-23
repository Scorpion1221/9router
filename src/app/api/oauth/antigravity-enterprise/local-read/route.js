import { NextResponse } from "next/server";
import { readLocalAntigravityEnterpriseBundle } from "@/lib/oauth/utils/antigravityEnterpriseCredentials";

/**
 * POST /api/oauth/antigravity-enterprise/local-read
 * Read the Antigravity desktop login on THIS machine (macOS keychain + the app's
 * embedded OAuth client) and return it as a JSON bundle the user can paste into
 * another 9Router (e.g. the Linux production gateway).
 *
 * Returns a live refresh token. Local-only + always protected in dashboardGuard.
 */
export async function POST() {
  try {
    const result = await readLocalAntigravityEnterpriseBundle();
    if (!result.found) return NextResponse.json({ error: result.error }, { status: 404 });
    return NextResponse.json({ bundle: result.bundle });
  } catch (error) {
    console.log("Antigravity Enterprise local read error:", error?.message);
    return NextResponse.json({ error: "Failed to read the Antigravity login" }, { status: 500 });
  }
}
