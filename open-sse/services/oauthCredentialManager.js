import { createHash } from "node:crypto";
import {
  getRefreshLeadMs,
  isUnrecoverableRefreshError,
  refreshTokenByProvider,
} from "./tokenRefresh.js";
import { PROVIDER_OAUTH } from "../providers/index.js";

// Single source: codex.oauth.maxRefreshAgeMs (8 days) — proactive refresh window
export const CODEX_MAX_REFRESH_AGE_MS = PROVIDER_OAUTH["codex"]?.maxRefreshAgeMs;

// Identifies a refresh token without storing it twice. deploy/bwg/oauth_handover.py
// computes the same value (sha256 hex, first 16 chars) to match the dead-token stamp.
export function refreshTokenFingerprint(refreshToken) {
  return refreshToken ? createHash("sha256").update(String(refreshToken)).digest("hex").slice(0, 16) : null;
}

// A row whose current refresh token was rejected for good (refreshTokenDeadFor stamp).
// Re-login writes a new refreshToken, so the stamp stops matching on its own.
export function hasDeadRefreshToken(credentials) {
  return !!credentials?.refreshTokenDeadFor
    && credentials.refreshTokenDeadFor === refreshTokenFingerprint(credentials.refreshToken);
}

// Shared via globalThis across bundled copies of this module — see tokenRefresh/dedup.js.
const refreshLocks = globalThis.__9rRefreshLocks ??= new Map();

// Providers whose refresh tokens are single-use: refreshing an already-rotated one
// revokes the login. Their refreshes also take the cross-process lease.
const SINGLE_USE_REFRESH = new Set(["claude", "codex", "grok-cli", "xai", "nous"]);
// How long to wait for another process to finish its refresh before giving up.
const LEASE_WAIT_MS = 20_000;
const LEASE_POLL_MS = 250;

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toExpiresAt(expiresIn, nowMs = Date.now()) {
  if (!expiresIn) return null;
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

export function getCredentialExpiryMs(credentials) {
  return parseTimeMs(credentials?.expiresAt ?? credentials?.tokenExpiresAt);
}

export function getCredentialLastRefreshMs(credentials) {
  return parseTimeMs(
    credentials?.lastRefreshAt ??
    credentials?.lastRefresh ??
    credentials?.providerSpecificData?.lastRefreshAt
  );
}

export function isCodexRefreshStale(credentials, nowMs = Date.now(), maxAgeMs = CODEX_MAX_REFRESH_AGE_MS) {
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  return !lastRefreshMs || nowMs - lastRefreshMs >= maxAgeMs;
}

export function shouldRefreshCredentials(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return false;
  // Every attempt would fail the same way until the account is signed in again.
  if (hasDeadRefreshToken(credentials)) return false;

  const expiresAtMs = getCredentialExpiryMs(credentials);
  if (expiresAtMs !== null && expiresAtMs - nowMs < getRefreshLeadMs(provider)) {
    return true;
  }

  // Proactive stale refresh for providers declaring oauth.maxRefreshAgeMs (e.g. codex)
  const maxAgeMs = PROVIDER_OAUTH[provider]?.maxRefreshAgeMs;
  if (maxAgeMs && credentials.refreshToken && isCodexRefreshStale(credentials, nowMs, maxAgeMs)) {
    return true;
  }

  return false;
}

export function mergeProviderSpecificData(existing, next) {
  if (!next || typeof next !== "object") return existing;
  return {
    ...(existing || {}),
    ...next,
  };
}

export function mergeRefreshedCredentials(provider, currentCredentials, refreshedCredentials, nowMs = Date.now()) {
  if (!refreshedCredentials) return null;
  if (isUnrecoverableRefreshError(refreshedCredentials)) return refreshedCredentials;

  const next = {};
  const nowIso = new Date(nowMs).toISOString();

  if (refreshedCredentials.accessToken) next.accessToken = refreshedCredentials.accessToken;
  if (refreshedCredentials.apiKey) next.apiKey = refreshedCredentials.apiKey;
  if (refreshedCredentials.token) next.token = refreshedCredentials.token;

  const refreshToken = refreshedCredentials.refreshToken ?? currentCredentials?.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;

  const idToken = refreshedCredentials.idToken ?? currentCredentials?.idToken;
  if (idToken) next.idToken = idToken;

  if (refreshedCredentials.expiresIn) {
    next.expiresIn = refreshedCredentials.expiresIn;
    next.expiresAt = toExpiresAt(refreshedCredentials.expiresIn, nowMs);
  } else if (refreshedCredentials.expiresAt) {
    next.expiresAt = refreshedCredentials.expiresAt;
  }

  if (refreshedCredentials.projectId) next.projectId = refreshedCredentials.projectId;

  if (refreshedCredentials.providerSpecificData) {
    next.providerSpecificData = mergeProviderSpecificData(
      currentCredentials?.providerSpecificData,
      refreshedCredentials.providerSpecificData
    );
  }

  if (refreshedCredentials.copilotToken) next.copilotToken = refreshedCredentials.copilotToken;
  if (refreshedCredentials.copilotTokenExpiresAt) {
    next.copilotTokenExpiresAt = refreshedCredentials.copilotTokenExpiresAt;
  }

  // trackRefreshAt providers (e.g. codex) always stamp lastRefreshAt for staleness tracking
  if (
    PROVIDER_OAUTH[provider]?.trackRefreshAt ||
    next.accessToken ||
    next.apiKey ||
    next.token ||
    next.refreshToken ||
    next.copilotToken
  ) {
    next.lastRefreshAt = refreshedCredentials.lastRefreshAt || nowIso;
  }

  return next;
}

function getRefreshLockKey(provider, credentials) {
  const stableId =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name ||
    credentials?.refreshToken?.slice?.(-16) ||
    "default";
  return `${provider}:${stableId}`;
}

export async function withCredentialRefreshLock(provider, credentials, refreshFn) {
  const key = getRefreshLockKey(provider, credentials);
  const existing = refreshLocks.get(key);
  if (existing) return existing;

  const pending = Promise.resolve()
    .then(refreshFn)
    .finally(() => {
      refreshLocks.delete(key);
    });

  refreshLocks.set(key, pending);
  return pending;
}

// Lease store (src/lib/db): loaded lazily so open-sse still runs without the app's DB.
// Tests swap it with __setRefreshLeaseStoreForTests.
let leaseStoreOverride;
async function leaseStore() {
  if (leaseStoreOverride !== undefined) return leaseStoreOverride;
  try {
    const [lease, conns, driver] = await Promise.all([
      import("../../src/lib/db/repos/refreshLeaseRepo.js"),
      import("../../src/lib/db/repos/connectionsRepo.js"),
      import("../../src/lib/db/driver.js"),
    ]);
    const db = await driver.getAdapter();
    if (!lease.refreshLeaseIsShared(db)) return null;
    return {
      acquire: (id) => lease.acquireRefreshLease(id),
      release: (id) => lease.releaseRefreshLease(id),
      read: (id) => conns.getProviderConnectionById(id),
      // Write the rotated tokens, unless the row no longer holds the token we spent
      // (e.g. a re-login meanwhile): never overwrite a newer login.
      save: (id, spentRefreshToken, patch) => conns.updateProviderConnectionWith(id,
        (current) => (current.refreshToken === spentRefreshToken ? patch : null)),
      ttlMs: lease.REFRESH_LEASE_TTL_MS,
    };
  } catch {
    return null;
  }
}

export function __setRefreshLeaseStoreForTests(store) {
  leaseStoreOverride = store;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SQLite lock contention: the other process is writing. Retry like a held lease,
// never fall back to an unguarded refresh (that is the double spend this prevents).
const isBusy = (e) => /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(`${e?.code || ""} ${e?.message || e}`);
// A stored access token adopted from another instance must still be usable.
const ADOPT_MIN_VALIDITY_MS = 60_000;

function usableStored(stored, credentials) {
  if (!stored?.refreshToken || stored.refreshToken === credentials.refreshToken) return false;
  if (!stored.accessToken) return false;
  const exp = getCredentialExpiryMs(stored);
  return exp === null || exp - Date.now() > ADOPT_MIN_VALIDITY_MS;
}

// What the stored row looks like after another instance refreshed it, shaped like
// mergeRefreshedCredentials' result so callers persist and use it the same way.
// No expiresIn: persisters would recompute expiresAt from now + expiresIn.
function adoptStored(stored) {
  const next = { refreshToken: stored.refreshToken };
  for (const k of ["accessToken", "idToken", "expiresAt", "lastRefreshAt", "projectId"]) {
    if (stored[k] !== undefined && stored[k] !== null) next[k] = stored[k];
  }
  if (stored.providerSpecificData) next.providerSpecificData = stored.providerSpecificData;
  return next;
}

// Token fields of a refresh result, to save while the lease is still held.
function tokenPatch(next) {
  const patch = {};
  for (const k of ["accessToken", "refreshToken", "idToken", "expiresAt", "expiresIn", "lastRefreshAt"]) {
    if (next[k] !== undefined && next[k] !== null) patch[k] = next[k];
  }
  return patch;
}

/**
 * Refresh a single-use token while holding the cross-process lease for its
 * connection (another 9router process may share the data dir, e.g. the other
 * slot during a rolling deploy).
 *
 * Under the lease the stored row is re-read. If another process already rotated
 * the token and the stored access token is still good, that is adopted and
 * nothing is spent. Otherwise the refresh runs with the stored refresh token, and
 * the rotated tokens are saved before the lease is released: callers save again
 * afterwards, but by then another process could already have read the old token.
 *
 * Fail-open: with no usable lease store (no connection id, sql.js, DB error) it
 * refreshes as before, guarded by the in-process lock only.
 */
async function withRefreshLease(provider, credentials, refreshFn, log) {
  const id = credentials?.connectionId || credentials?.id;
  if (!id || !SINGLE_USE_REFRESH.has(provider) || !credentials?.refreshToken) return refreshFn(credentials);
  const store = await leaseStore();
  if (!store) return refreshFn(credentials);

  const deadline = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    let held = false;
    try {
      held = await store.acquire(id);
    } catch (e) {
      if (!isBusy(e)) {
        // No usable lease table (e.g. a read-only or broken DB): refresh as before.
        log?.warn?.("TOKEN_REFRESH", `refresh lease unavailable, refreshing without it: ${e?.message || e}`);
        return refreshFn(credentials);
      }
    }
    if (held) break;
    // Another process is refreshing. If it finishes while we wait, use its result.
    const stored = await store.read(id).catch(() => null);
    if (usableStored(stored, credentials)) {
      log?.info?.("TOKEN_REFRESH", `${provider} refreshed by another instance; using its tokens`);
      return adoptStored(stored);
    }
    if (Date.now() >= deadline) {
      // Never spend the token while another process may be spending it too.
      log?.warn?.("TOKEN_REFRESH", `${provider} refresh lease busy for ${LEASE_WAIT_MS / 1000}s; skipping this refresh`);
      return null;
    }
    await sleep(LEASE_POLL_MS);
  }

  // Keep the lease alive through a slow token call; a crashed process stops renewing.
  const ttl = store.ttlMs || 90_000;
  const heartbeat = setInterval(() => { store.acquire(id).catch(() => {}); }, Math.max(1000, Math.floor(ttl / 3)));
  heartbeat.unref?.();
  try {
    let creds = credentials;
    const stored = await store.read(id).catch(() => null);
    if (stored?.refreshToken && stored.refreshToken !== credentials.refreshToken) {
      if (usableStored(stored, credentials)) {
        log?.info?.("TOKEN_REFRESH", `${provider} refresh token already rotated in the store; using it`);
        return adoptStored(stored);
      }
      // Our snapshot is stale and the stored access token is no good either:
      // refresh with the stored refresh token, the only one still valid.
      creds = { ...credentials, refreshToken: stored.refreshToken, accessToken: stored.accessToken };
    }
    const next = await refreshFn(creds);
    if (next && !isUnrecoverableRefreshError(next) && next.accessToken && next.refreshToken) {
      await store.save(id, creds.refreshToken, tokenPatch(next)).catch((e) => {
        log?.warn?.("TOKEN_REFRESH", `${provider} could not save rotated tokens under the lease: ${e?.message || e}`);
      });
    }
    return next;
  } finally {
    clearInterval(heartbeat);
    await store.release(id).catch(() => {});
  }
}

export async function refreshProviderCredentials(provider, credentials, log) {
  if (!credentials) return null;

  return withCredentialRefreshLock(provider, credentials, () =>
    withRefreshLease(provider, credentials, async (creds) => {
      const refreshed = await refreshTokenByProvider(provider, creds, log);
      return mergeRefreshedCredentials(provider, creds, refreshed);
    }, log));
}
