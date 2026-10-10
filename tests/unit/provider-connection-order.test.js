/**
 * Account order: the whole order is written in one transaction. The old UI swapped
 * two rows with two independent `priority` PUTs; each renumbered the pool, so the
 * stored order drifted from what the dashboard showed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let repo;
const PROV = "openrouter";

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-order-"));
  repo = await import("../../src/lib/db/repos/connectionsRepo.js");
});

async function seed(names) {
  for (const c of await repo.getProviderConnections({ provider: PROV })) await repo.deleteProviderConnection(c.id);
  const ids = {};
  for (const n of names) {
    const c = await repo.createProviderConnection({ provider: PROV, authType: "apikey", name: n, apiKey: `sk-${n}` });
    ids[n] = c.id;
  }
  return ids;
}
const order = async () => (await repo.getProviderConnections({ provider: PROV })).map((c) => c.name).join("");

describe("setProviderConnectionOrder", () => {
  it("stores exactly the given order as priorities 1..N", async () => {
    const ids = await seed(["A", "B", "C", "D"]);
    const r = await repo.setProviderConnectionOrder(PROV, ["C", "A", "D", "B"].map((n) => ids[n]));
    expect(r.ok).toBe(true);
    expect(await order()).toBe("CADB");
    expect((await repo.getProviderConnections({ provider: PROV })).map((c) => c.priority)).toEqual([1, 2, 3, 4]);
  });

  it("rejects a partial, duplicated or foreign id list and leaves the order alone", async () => {
    const ids = await seed(["A", "B", "C"]);
    const before = await order();
    expect((await repo.setProviderConnectionOrder(PROV, [ids.A, ids.B])).ok).toBe(false);
    expect((await repo.setProviderConnectionOrder(PROV, [ids.A, ids.A, ids.B])).ok).toBe(false);
    expect((await repo.setProviderConnectionOrder(PROV, [ids.A, ids.B, "nope"])).ok).toBe(false);
    expect(await order()).toBe(before);
  });

  it("the old two-PUT swap drifts; a full-order write doesn't", async () => {
    const ids = await seed(["A", "B", "C", "D", "E"]);
    // old UI: move B down (swap idx 1,2) by writing 0-based priorities to both rows
    await repo.updateProviderConnection(ids.C, { priority: 1 });
    await repo.updateProviderConnection(ids.B, { priority: 2 });
    expect(await order()).not.toBe("ACBDE");

    await seed(["A", "B", "C", "D", "E"]).then((fresh) => repo.setProviderConnectionOrder(PROV, ["A", "C", "B", "D", "E"].map((n) => fresh[n])));
    expect(await order()).toBe("ACBDE");
  });
});
