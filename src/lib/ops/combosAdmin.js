// Combo writes for the ops API (/api/ops/combos). Same rules as the dashboard's
// /api/combos routes, plus what the dashboard page does around them in the
// browser (prune settings.comboStrategies on delete, move it on rename), so a
// CLI write leaves the same state a dashboard write would.
import { getCombos, getComboById, getComboByName, createCombo, updateCombo, deleteCombo } from "@/lib/db/repos/combosRepo.js";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { resetComboRotation } from "open-sse/services/combo.js";
import { opsError } from "./auth.js";

export const COMBO_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
export const COMBO_STRATEGIES = ["fallback", "round-robin", "fusion"];
export const COMBO_KINDS = ["llm", "image", "tts", "stt", "embedding", "imageToText", "webSearch", "webFetch"];
const MAX_MODELS = 32;
const MAX_MODEL_LEN = 200;
// A model entry is `provider/model` or another combo's name; never whitespace or control chars.
const MODEL_RE = /^[^\s\u0000-\u001f]+$/;

/** Public combo shape with its effective strategy. */
export function comboView(combo, settings) {
  const entry = (settings.comboStrategies || {})[combo.name] || {};
  return {
    id: combo.id,
    name: combo.name,
    kind: combo.kind || "llm",
    strategy: entry.fallbackStrategy || settings.comboStrategy || "fallback",
    models: combo.models || [],
    updatedAt: combo.updatedAt || null,
  };
}

export async function resolveCombo(idOrName) {
  const combo = (await getComboById(idOrName)) || (await getComboByName(idOrName));
  if (!combo) throw opsError(404, `no combo '${idOrName}'`);
  return combo;
}

function validateName(name) {
  if (typeof name !== "string" || !name) throw opsError(400, "name is required");
  if (!COMBO_NAME_RE.test(name)) throw opsError(400, "name can only contain letters, numbers, '-', '_' and '.'");
  if (name.length > 100) throw opsError(400, "name is longer than 100 characters");
}

function validateModels(models, selfName) {
  if (!Array.isArray(models)) throw opsError(400, "models must be an array of model ids");
  if (models.length > MAX_MODELS) throw opsError(400, `at most ${MAX_MODELS} models per combo`);
  const seen = new Set();
  for (const m of models) {
    if (typeof m !== "string" || !m || m.length > MAX_MODEL_LEN || !MODEL_RE.test(m)) throw opsError(400, `invalid model id '${String(m).slice(0, 60)}'`);
    if (m === selfName) throw opsError(400, "a combo cannot contain itself");
    if (seen.has(m)) throw opsError(400, `duplicate model '${m}'`);
    seen.add(m);
  }
}

// Nested combos are resolved by name at request time; refuse a chain that loops back.
async function assertNoCycle(name, models) {
  const all = await getCombos();
  const byName = new Map(all.map((c) => [c.name, c.models || []]));
  byName.set(name, models);
  const stack = [...models];
  const seen = new Set();
  while (stack.length) {
    const m = stack.pop();
    if (m === name) throw opsError(400, `combo '${name}' would include itself through a nested combo`);
    if (seen.has(m) || m.includes("/")) continue;
    seen.add(m);
    stack.push(...(byName.get(m) || []));
  }
}

async function setStrategy(name, strategy, { from = null } = {}) {
  const settings = await getSettings();
  const all = { ...(settings.comboStrategies || {}) };
  const prev = all[from || name] || {};
  if (from) delete all[from];
  const next = { ...prev };
  if (strategy !== undefined) next.fallbackStrategy = strategy;
  // Default "fallback" with no extras means no entry, as the dashboard stores it.
  const extras = Object.keys(next).filter((k) => k !== "fallbackStrategy");
  if ((!next.fallbackStrategy || next.fallbackStrategy === "fallback") && !extras.length) delete all[name];
  else all[name] = next;
  await updateSettings({ comboStrategies: all });
}

/** API keys whose allow list names this combo (they lose access when it goes away or is renamed). */
async function keysReferencing(name) {
  const keys = await getApiKeys();
  const lower = name.toLowerCase();
  return keys.filter((k) => k.access?.restricted && (k.access.allow || []).some((e) => String(e).toLowerCase() === lower)).map((k) => k.name);
}

export async function listCombosAdmin() {
  const [combos, settings] = await Promise.all([getCombos(), getSettings()]);
  return combos.map((c) => comboView(c, settings));
}

export async function getComboAdmin(idOrName) {
  const [combo, settings] = await Promise.all([resolveCombo(idOrName), getSettings()]);
  return { ...comboView(combo, settings), keys: await keysReferencing(combo.name) };
}

export async function createComboAdmin(body) {
  const { name, models = [], kind = null, strategy } = body || {};
  validateName(name);
  validateModels(models, name);
  if (kind !== null && !COMBO_KINDS.includes(kind)) throw opsError(400, `kind must be one of ${COMBO_KINDS.join(", ")}`);
  if (strategy !== undefined && !COMBO_STRATEGIES.includes(strategy)) throw opsError(400, `strategy must be one of ${COMBO_STRATEGIES.join(", ")}`);
  if (await getComboByName(name)) throw opsError(409, `combo '${name}' already exists`);
  await assertNoCycle(name, models);
  const combo = await createCombo({ name, models, kind: kind === "llm" ? null : kind });
  if (strategy !== undefined) await setStrategy(name, strategy);
  return comboView(combo, await getSettings());
}

export async function updateComboAdmin(idOrName, body) {
  const prev = await resolveCombo(idOrName);
  const { name, models, kind, strategy } = body || {};
  const patch = {};
  if (name !== undefined && name !== prev.name) {
    validateName(name);
    const clash = await getComboByName(name);
    if (clash && clash.id !== prev.id) throw opsError(409, `combo '${name}' already exists`);
    patch.name = name;
  }
  const finalName = patch.name || prev.name;
  if (models !== undefined) {
    validateModels(models, finalName);
    patch.models = models;
  }
  if (kind !== undefined) {
    if (kind !== null && !COMBO_KINDS.includes(kind)) throw opsError(400, `kind must be one of ${COMBO_KINDS.join(", ")}`);
    patch.kind = kind === "llm" ? null : kind;
  }
  if (strategy !== undefined && !COMBO_STRATEGIES.includes(strategy)) throw opsError(400, `strategy must be one of ${COMBO_STRATEGIES.join(", ")}`);
  if (patch.models || patch.name) await assertNoCycle(finalName, patch.models || prev.models || []);

  const settingsBefore = await getSettings();
  const before = comboView(prev, settingsBefore);
  const updated = Object.keys(patch).length ? await updateCombo(prev.id, patch) : prev;
  if (patch.name || strategy !== undefined) await setStrategy(finalName, strategy, { from: patch.name ? prev.name : null });
  resetComboRotation(prev.name);
  if (patch.name) resetComboRotation(patch.name);

  const after = comboView(updated, await getSettings());
  const changed = {};
  for (const k of ["name", "kind", "strategy", "models"]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = { from: before[k], to: after[k] };
  }
  const warnings = patch.name ? (await keysReferencing(prev.name)).map((k) => `key '${k}' allows '${prev.name}' and loses access after the rename`) : [];
  return { combo: after, changed, warnings };
}

export async function deleteComboAdmin(idOrName) {
  const combo = (await getComboById(idOrName)) || (await getComboByName(idOrName));
  if (!combo) return { deleted: null, alreadyGone: true };
  const keys = await keysReferencing(combo.name);
  await deleteCombo(combo.id);
  await setStrategy(combo.name, "fallback");
  resetComboRotation(combo.name);
  return { deleted: combo.name, alreadyGone: false, warnings: keys.map((k) => `key '${k}' still lists '${combo.name}' in its allow list`) };
}
