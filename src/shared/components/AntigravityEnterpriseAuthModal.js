"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

/**
 * Antigravity Enterprise: add a Gemini Enterprise login by pasting the JSON bundle
 * (OAuth client + refresh token + project/tier) read from the Antigravity desktop app.
 * "Read from this Mac" fills the box when 9Router runs on the Mac where Antigravity is
 * signed in (local-only route); copy that JSON to add the same login on another 9Router.
 */
export default function AntigravityEnterpriseAuthModal({ isOpen, onSuccess, onClose }) {
  const [bundleText, setBundleText] = useState("");
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleClose = () => {
    setBundleText("");
    setError(null);
    setResult(null);
    setCopied(false);
    onClose();
  };

  const handleReadLocal = async () => {
    setReading(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/antigravity-enterprise/local-read", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(res.status === 403
          ? "Reading the Antigravity app only works when this 9Router runs on that Mac. Read it there and paste the JSON here."
          : data.error || "Could not read the Antigravity login");
      }
      setBundleText(JSON.stringify(data.bundle, null, 2));
    } catch (err) {
      setError(err.message);
    } finally {
      setReading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bundleText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy failed; select the text and copy it manually.");
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      let bundle;
      try { bundle = JSON.parse(bundleText); } catch { throw new Error("The pasted text is not valid JSON."); }
      const res = await fetch("/api/oauth/antigravity-enterprise/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Import failed");
      setResult(data.connection);
      setBundleText("");
      onSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Add Antigravity Enterprise account" onClose={handleClose}>
      <div className="flex flex-col gap-4">
        {!result && (
          <>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                <div className="text-sm text-blue-800 dark:text-blue-200 flex flex-col gap-1">
                  <p>Sign in to the Antigravity desktop app with your Workspace (Gemini Enterprise) account.</p>
                  <p>
                    On that Mac, open 9Router and click <strong>Read from this Mac</strong> (macOS may ask to allow keychain access).
                    To add the account on another 9Router, copy the JSON and paste it there.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="age-bundle" className="block text-sm font-medium">Login JSON</label>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={handleReadLocal} disabled={reading || importing}>
                    {reading ? "Reading..." : "Read from this Mac"}
                  </Button>
                  {bundleText.trim() && (
                    <Button size="sm" variant="ghost" onClick={handleCopy}>
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  )}
                </div>
              </div>
              <textarea
                id="age-bundle"
                value={bundleText}
                onChange={(e) => setBundleText(e.target.value)}
                placeholder='{"clientId": "...", "clientSecret": "...", "refreshToken": "...", "projectId": "...", "userTier": "..."}'
                rows={8}
                spellCheck={false}
                className="w-full px-3 py-2 text-xs font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-y"
              />
              <p className="text-xs text-text-muted mt-1">
                Contains a refresh token for your account. Treat it like a password.
              </p>
            </div>
          </>
        )}

        {result && (
          <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800">
            <div className="flex gap-2">
              <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
              <p className="text-sm text-green-800 dark:text-green-200">
                Added {result.email || "account"} · {result.tier} · project {result.projectId} · {result.modelCount} models
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex gap-2">
          {!result && (
            <Button onClick={handleImport} fullWidth disabled={importing || !bundleText.trim()}>
              {importing ? "Adding..." : "Add account"}
            </Button>
          )}
          <Button onClick={handleClose} variant="ghost" fullWidth>
            {result ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AntigravityEnterpriseAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
