// Module resolve hooks for child processes in tests: the "@/…" and "open-sse/…"
// aliases that tests/vitest.config.js gives vitest. NINEROUTER_ROOT = repo root.
import { pathToFileURL } from "node:url";

const ROOT = process.env.NINEROUTER_ROOT;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    let p = `${ROOT}/src/${specifier.slice(2)}`;
    if (!/\.(m?js|json)$/.test(p)) p += ".js";
    return next(pathToFileURL(p).href, context);
  }
  if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    return next(pathToFileURL(`${ROOT}/${specifier}`).href, context);
  }
  return next(specifier, context);
}
