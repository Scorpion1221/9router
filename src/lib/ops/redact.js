// Scrub credentials out of free text before it leaves through /api/ops/*.
// Upstream and fetch errors can echo a base URL with userinfo, a query-string
// key, a bearer token or a raw key; connection names are sometimes the key.

const TOKENISH = /[A-Za-z0-9_\-]{32,}/g;

export function redactSecrets(text, max = 200) {
  if (text == null) return null;
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/([?&](?:key|api[_-]?key|token|access[_-]?token|secret|password)=)[^&\s"']+/gi, "$1***")
    .replace(/(bearer\s+)\S+/gi, "$1***")
    .replace(/(sk-|9rops_|AIza|ghp_|gho_|xox[bap]-)[A-Za-z0-9_\-]{8,}/g, "$1***")
    .replace(TOKENISH, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`)
    .slice(0, max);
}

// Names are shown, and used as handles, but a name that looks like a key is masked.
export function maskName(name) {
  if (!name) return name;
  const str = String(name);
  return /[A-Za-z0-9_\-]{32,}/.test(str) ? str.replace(TOKENISH, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`) : str;
}
