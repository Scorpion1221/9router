// Bounded JSON size estimation, preview generation, and truncation.
// Avoids allocating multi-megabyte strings via JSON.stringify() when checking
// whether large request/response payloads exceed the observability cap.

const DEFAULT_PREVIEW_CHARS = 200;
const DEFAULT_MAX_NODES = 20_000;

/**
 * Estimate the JSON-serialized character length of `value` without allocating
 * a serialized string. Stops early once `limit` is exceeded or `maxNodes`
 * containers/entries have been visited so huge/deep payloads stay bounded.
 *
 * Returns `{ size, exceeded, circular }`:
 * - `size` is a tight lower-bound character count (exact for plain ASCII JSON
 *   when not stopped early).
 * - `exceeded` is true if the limit or node cap was crossed.
 * - `circular` is true if a cycle was detected.
 */
export function estimateJsonLength(value, limit = Infinity, maxNodes = DEFAULT_MAX_NODES) {
  let size = 0;
  let nodes = 0;
  let exceeded = false;
  let circular = false;
  const active = new Set();

  function walk(v) {
    if (exceeded) return;
    if (v === null) { size += 4; return; }
    const t = typeof v;
    if (t === "string") {
      size += v.length + 2;
      if (size > limit) exceeded = true;
      return;
    }
    if (t === "number") {
      size += Number.isFinite(v) ? String(v).length : 4;
      if (size > limit) exceeded = true;
      return;
    }
    if (t === "boolean") {
      size += v ? 4 : 5;
      if (size > limit) exceeded = true;
      return;
    }
    if (t === "undefined" || t === "function" || t === "symbol") {
      size += 4;
      return;
    }
    if (t === "bigint") {
      size += String(v).length;
      if (size > limit) exceeded = true;
      return;
    }
    if (v instanceof Date) {
      size += 26;
      if (size > limit) exceeded = true;
      return;
    }
    if (active.has(v)) {
      circular = true;
      size += 10;
      return;
    }
    if (++nodes > maxNodes) {
      exceeded = true;
      return;
    }

    active.add(v);
    if (Array.isArray(v)) {
      size += 2; // []
      if (size > limit) { exceeded = true; active.delete(v); return; }
      for (let i = 0; i < v.length; i++) {
        if (i > 0) size += 1;
        walk(v[i]);
        if (exceeded || ++nodes > maxNodes) {
          if (nodes > maxNodes) exceeded = true;
          break;
        }
      }
    } else {
      size += 2; // {}
      if (size > limit) { exceeded = true; active.delete(v); return; }
      let first = true;
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        const prop = v[k];
        if (prop === undefined || typeof prop === "function" || typeof prop === "symbol") continue;
        if (!first) size += 1;
        first = false;
        size += k.length + 3; // "k":
        if (size > limit) { exceeded = true; break; }
        walk(prop);
        if (exceeded || ++nodes > maxNodes) {
          if (nodes > maxNodes) exceeded = true;
          break;
        }
      }
    }
    active.delete(v);
  }

  walk(value);
  return { size, exceeded: exceeded || size > limit, circular };
}

/**
 * Produce at most `maxChars` of JSON preview text without serializing the full
 * object graph. Stops writing as soon as `maxChars` characters are emitted.
 */
export function jsonPreview(value, maxChars = DEFAULT_PREVIEW_CHARS) {
  let out = "";
  const active = new Set();

  function append(s) {
    if (out.length >= maxChars) return;
    const rem = maxChars - out.length;
    out += s.length <= rem ? s : s.slice(0, rem);
  }

  function appendJsonString(s) {
    if (out.length >= maxChars) return;
    // Only JSON-escape as many source characters as could possibly fit in the remaining window.
    const rem = maxChars - out.length;
    append(JSON.stringify(s.length <= rem ? s : s.slice(0, rem)));
  }

  function emit(v) {
    if (out.length >= maxChars) return;
    if (v === null) { append("null"); return; }
    const t = typeof v;
    if (t === "string") { appendJsonString(v); return; }
    if (t === "number") { append(Number.isFinite(v) ? String(v) : "null"); return; }
    if (t === "boolean") { append(v ? "true" : "false"); return; }
    if (t === "bigint") { append(String(v)); return; }
    if (t === "undefined" || t === "function" || t === "symbol") { append("null"); return; }
    if (v instanceof Date) {
      appendJsonString(Number.isNaN(v.getTime()) ? "null" : v.toISOString());
      return;
    }
    if (active.has(v)) { append('"[Circular]"'); return; }

    active.add(v);
    if (Array.isArray(v)) {
      append("[");
      for (let i = 0; i < v.length && out.length < maxChars; i++) {
        if (i > 0) append(",");
        emit(v[i]);
      }
      append("]");
    } else {
      append("{");
      let first = true;
      for (const k in v) {
        if (out.length >= maxChars) break;
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        const prop = v[k];
        if (prop === undefined || typeof prop === "function" || typeof prop === "symbol") continue;
        if (!first) append(",");
        first = false;
        appendJsonString(k);
        append(":");
        emit(prop);
      }
      append("}");
    }
    active.delete(v);
  }

  emit(value);
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}

/**
 * Truncate an observability payload field if its serialized JSON size exceeds
 * `maxSize`, without calling JSON.stringify() on oversized objects.
 * Idempotent: already-truncated markers pass straight through.
 */
export function truncateJsonField(obj, maxSize) {
  if (obj == null) return {};
  if (typeof obj === "object" && obj._truncated === true) return obj;

  if (typeof obj === "string") {
    if (obj.length + 2 > maxSize) {
      return {
        _truncated: true,
        _originalSize: obj.length + 2,
        _preview: jsonPreview(obj, DEFAULT_PREVIEW_CHARS),
      };
    }
    const str = JSON.stringify(obj);
    if (str.length > maxSize) {
      return {
        _truncated: true,
        _originalSize: str.length,
        _preview: str.substring(0, DEFAULT_PREVIEW_CHARS),
      };
    }
    return obj;
  }

  // Single bounded walk (zero large string allocation): measures total size up
  // to DEFAULT_MAX_NODES so oversized payloads never invoke JSON.stringify().
  const probe = estimateJsonLength(obj, Infinity);
  if (probe.circular || probe.exceeded || probe.size > maxSize) {
    return {
      _truncated: true,
      _originalSize: probe.size,
      _preview: jsonPreview(obj, DEFAULT_PREVIEW_CHARS),
    };
  }

  try {
    const str = JSON.stringify(obj);
    if (str.length > maxSize) {
      return {
        _truncated: true,
        _originalSize: str.length,
        _preview: str.substring(0, DEFAULT_PREVIEW_CHARS),
      };
    }
    // Detached copy so callers/closures can release the original tree and later mutations don't alias.
    return JSON.parse(str);
  } catch {
    return {
      _truncated: true,
      _originalSize: probe.size,
      _preview: jsonPreview(obj, DEFAULT_PREVIEW_CHARS),
    };
  }
}
