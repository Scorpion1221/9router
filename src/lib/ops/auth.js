// Authentication for /api/ops/*: Bearer ops token only.
//
// Cookies, the dashboard password, the machine CLI token and /v1 inference keys
// are all rejected here, so a leaked inference key or a browser session can't
// manage the gateway, and there is no cookie for CSRF to ride on. Failed
// attempts are rate limited per client IP (same progressive lockout as the
// dashboard login), and every failure answers the same 401 so the response
// doesn't reveal whether a token exists, is revoked or expired.
import { NextResponse } from "next/server";
import { verifyOpsToken, scopeAllows, OPS_TOKEN_PREFIX } from "@/lib/db/repos/opsTokensRepo.js";
import { checkLock, recordFail, getClientIp } from "@/lib/auth/loginLimiter.js";

// Own bucket namespace so ops failures and dashboard login failures don't share a counter.
const BUCKET = (ip) => `ops:${ip}`;

function bearer(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

function json(body, status, headers = {}) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * Authorize an ops request. Returns { token } on success or { response } to
 * send back as-is.
 */
export async function authorizeOps(request, requiredScope = "read") {
  const ip = getClientIp(request);
  const presented = bearer(request);
  // Verify before consulting the lockout: a 256-bit token can't be guessed, so
  // the lockout is only defence in depth and must never block a valid token
  // (behind a proxy many clients can share one bucket).
  const token = presented ? await verifyOpsToken(presented, { ip }) : null;
  if (!token) {
    const lock = checkLock(BUCKET(ip));
    if (lock.locked) {
      return { response: json({ error: "too many failed attempts", retryAfter: lock.retryAfter }, 429, { "Retry-After": String(lock.retryAfter) }) };
    }
    // Only a presented ops-shaped token counts as a guess; scanners without one don't.
    if (presented?.startsWith(OPS_TOKEN_PREFIX)) recordFail(BUCKET(ip));
    return { response: json({ error: "unauthorized", hint: "send Authorization: Bearer <ops token>" }, 401) };
  }
  if (!scopeAllows(token.scope, requiredScope)) {
    return { response: json({ error: `token scope '${token.scope}' cannot do this (needs '${requiredScope}')` }, 403) };
  }
  return { token };
}

/** Wrap a route handler: auth + uniform JSON errors with no internals leaked. */
export function opsRoute(requiredScope, handler) {
  return async (request, ctx) => {
    const auth = await authorizeOps(request, requiredScope);
    if (auth.response) return auth.response;
    try {
      const body = await handler(request, { ...ctx, token: auth.token });
      return body instanceof Response ? body : json(body, 200);
    } catch (error) {
      // 4xx, and 5xx raised with opsError (their message is written for the caller;
      // anything thrown elsewhere stays "internal error").
      if (error?.status && (error.status < 500 || error.expose === true)) return json({ error: error.message }, error.status);
      console.error(`[ops] ${new URL(request.url).pathname} failed: ${error?.message || error}`);
      return json({ error: "internal error" }, 500);
    }
  };
}

export function opsError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
