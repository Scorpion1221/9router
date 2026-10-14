// Minimal TOON encoder (https://toonformat.dev): objects, primitive arrays,
// tabular arrays of uniform flat objects, and list arrays. Comma delimiter.
// Big integers / non-finite numbers are emitted as null (we never send them).

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
// Spec §7.2 numeric-like: optional sign, digits, optional fraction and exponent,
// plus leading-zero forms like 05.
const NUMERIC_RE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const LEADING_ZERO_RE = /^0\d+$/;
const INDENT = "  ";

function quote(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

function needsQuote(s) {
  return s === "" || s !== s.trim() || s === "true" || s === "false" || s === "null" || NUMERIC_RE.test(s) || LEADING_ZERO_RE.test(s)
    || /[:"\\[\]{},\u0000-\u001f]/.test(s) || s.startsWith("-") || s.startsWith("#");
}

function num(n) {
  if (!Number.isFinite(n)) return "null";
  if (Object.is(n, -0)) return "0";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e21)) return String(n).replace("e+", "e+").toLowerCase();
  return String(n);
}

export function primitive(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return num(v);
  const s = String(v);
  return needsQuote(s) ? quote(s) : s;
}

const isPrim = (v) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
const isPlainObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const key = (k) => (KEY_RE.test(k) ? k : quote(k));

function tabularFields(arr) {
  if (!arr.length || !arr.every(isPlainObj)) return null;
  const fields = Object.keys(arr[0]);
  if (!fields.length) return null;
  for (const o of arr) {
    const ks = Object.keys(o);
    if (ks.length !== fields.length || !fields.every((f) => f in o) || !ks.every((f) => isPrim(o[f]))) return null;
  }
  return fields;
}

function encodeArray(name, arr, depth, out, nested = false) {
  const pad = INDENT.repeat(depth);
  const head = name == null ? "" : key(name);
  if (!arr.length) { out.push(`${pad}${head}${name == null ? (depth === 0 && nested === false ? "[]" : "[0]:") : ": []"}`); return; }
  if (arr.every(isPrim)) { out.push(`${pad}${head}[${arr.length}]: ${arr.map(primitive).join(",")}`); return; }
  // Spec §9.4: an array nested as a list item can't use tabular form.
  const fields = nested ? null : tabularFields(arr);
  if (fields) {
    out.push(`${pad}${head}[${arr.length}]{${fields.map(key).join(",")}}:`);
    for (const o of arr) out.push(`${pad}${INDENT}${fields.map((f) => primitive(o[f])).join(",")}`);
    return;
  }
  out.push(`${pad}${head}[${arr.length}]:`);
  for (const item of arr) {
    const ip = `${pad}${INDENT}`;
    if (isPrim(item)) out.push(`${ip}- ${primitive(item)}`);
    else if (Array.isArray(item)) {
      const sub = [];
      encodeArray(null, item, 0, sub, true);
      out.push(`${ip}- ${sub[0]}`);
      for (const line of sub.slice(1)) out.push(`${ip}  ${line}`);
    } else {
      const entries = Object.entries(item);
      if (!entries.length) { out.push(`${ip}-`); continue; }
      const sub = [];
      encodeObject(Object.fromEntries(entries), 0, sub);
      out.push(`${ip}- ${sub[0]}`);
      for (const line of sub.slice(1)) out.push(`${ip}  ${line}`);
    }
  }
}

function encodeObject(obj, depth, out) {
  const pad = INDENT.repeat(depth);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) encodeArray(k, v, depth, out);
    else if (isPlainObj(v)) {
      out.push(`${pad}${key(k)}:`);
      encodeObject(v, depth + 1, out);
    } else out.push(`${pad}${key(k)}: ${primitive(v)}`);
  }
}

/** Encode a JSON-compatible value as TOON text (no trailing newline). */
export function toToon(value) {
  const out = [];
  if (Array.isArray(value)) encodeArray(null, value, 0, out);
  else if (isPlainObj(value)) encodeObject(value, 0, out);
  else out.push(primitive(value));
  return out.join("\n");
}
