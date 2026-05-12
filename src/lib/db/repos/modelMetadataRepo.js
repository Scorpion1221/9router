// Model metadata cache — stores OpenRouter-synced ctx/pricing for all known models.
// Lives in the kv table under scope='modelMetadata' (no schema migration needed).
//
// Layout:
//   scope='modelMetadata' key='__meta__'  value={ fetchedAt, count, source }
//   scope='modelMetadata' key=<orId>      value={ id, vendor, base, name,
//                                                  contextWindow, maxOutput,
//                                                  inputPrice, outputPrice,
//                                                  cachedPrice, cacheWritePrice,
//                                                  reasoningPrice, imagePrice }
//
// `<orId>` is OpenRouter's canonical "vendor/model" (e.g. "anthropic/claude-sonnet-4.6").
// `base` is the part after the slash, lowercased, for fast matching against our
// internal model IDs (which have no vendor prefix).
import { getAdapter } from "../driver.js";
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";

const SCOPE = "modelMetadata";
const META_KEY = "__meta__";

export async function getModelMetadataMeta() {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, META_KEY]);
  return row ? parseJson(row.value, null) : null;
}

export async function getModelMetadataById(orId) {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, orId]);
  return row ? parseJson(row.value, null) : null;
}

// Load whole table as { orId: entry } map. Used to build the in-memory matcher.
export async function getAllModelMetadata() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) {
    if (r.key === META_KEY) continue;
    out[r.key] = parseJson(r.value, null);
  }
  return out;
}

// Replace the whole cache atomically. `entries` is an array of normalized rows.
export async function replaceAllModelMetadata(entries, source = "openrouter") {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(`DELETE FROM kv WHERE scope = ?`, [SCOPE]);
    for (const e of entries) {
      if (!e?.id) continue;
      db.run(
        `INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)`,
        [SCOPE, e.id, stringifyJson(e)],
      );
    }
    db.run(
      `INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)`,
      [SCOPE, META_KEY, stringifyJson({ fetchedAt: now, count: entries.length, source })],
    );
  });
  return { fetchedAt: now, count: entries.length };
}
