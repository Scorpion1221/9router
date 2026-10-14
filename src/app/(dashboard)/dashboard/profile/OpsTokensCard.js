"use client";

import { useEffect, useState } from "react";
import { Card, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const SCOPE_HINT = {
  read: "status, quota, metrics",
  operate: "read + reversible account actions",
  admin: "everything, incl. managing tokens",
};

// Ops tokens for /api/ops/* and the 9r CLI. The plaintext is shown once.
export default function OpsTokensCard() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("read");
  const [created, setCreated] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);

  const load = async () => {
    const res = await fetch("/api/settings/ops-tokens");
    return res.ok ? (await res.json()).tokens || [] : null;
  };
  const reload = async () => {
    const list = await load();
    if (list) setTokens(list);
  };
  useEffect(() => {
    let alive = true;
    load().then((list) => { if (alive && list) setTokens(list); });
    return () => { alive = false; };
  }, []);

  const create = async () => {
    setBusy(true); setError(""); setCreated(null);
    try {
      const res = await fetch("/api/settings/ops-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create token");
      setCreated(data.token);
      setName("");
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    await fetch(`/api/settings/ops-tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await reload();
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">terminal</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold">Ops tokens</h3>
      </div>
      <p className="text-xs sm:text-sm text-text-muted mb-4">
        Bearer tokens for the ops API (<code>/api/ops/*</code>) and the <code>9r</code> CLI. Separate from API keys.
      </p>

      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. mac-9r or cron-check" className="flex-1" />
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm">
          {Object.keys(SCOPE_HINT).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button onClick={create} disabled={busy || !name.trim()}>Create</Button>
      </div>
      <p className="text-[11px] text-text-muted mb-3">{scope}: {SCOPE_HINT[scope]}</p>
      {error && <p className="text-xs text-red-500 mb-3">{error}</p>}

      {created && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-2">Copy it now — it won&apos;t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all text-xs">{created}</code>
            <Button variant="secondary" onClick={() => copy(created)}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="text-xs text-text-muted">No ops tokens yet.</p>
      ) : (
        <div className="divide-y divide-border-subtle">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{t.name} <span className="text-xs text-text-muted">· {t.scope} · {t.prefix}…</span></p>
                <p className="text-[11px] text-text-muted">
                  {t.revokedAt ? `revoked ${t.revokedAt.slice(0, 10)}` : t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 16).replace("T", " ")} from ${t.lastUsedIp || "?"}` : "never used"}
                </p>
              </div>
              {!t.revokedAt && <Button variant="secondary" onClick={() => revoke(t.id)}>Revoke</Button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
