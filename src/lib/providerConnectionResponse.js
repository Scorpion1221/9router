import { AI_PROVIDERS } from "@/shared/constants/providers";
import { hasDeadRefreshToken } from "open-sse/services/oauthCredentialManager.js";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...rest } = connection;
  // The dead-token stamp only counts while it matches the current refresh token, which
  // never leaves the server; send the verdict instead so the dashboard can flag the login.
  const safe = hasDeadRefreshToken(connection) ? { ...rest, refreshTokenDead: true } : rest;

  if (!usesAwsCredentialForm(connection.provider) || !connection.providerSpecificData) {
    return safe;
  }

  const { sessionToken, ...providerSpecificData } = connection.providerSpecificData;
  return { ...safe, providerSpecificData };
}
