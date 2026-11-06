"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const logRef = useRef(null);
  // Follow new lines only while the view is at the bottom. Scrolling up freezes the
  // view (the 200-line window would otherwise trim what you are reading); scrolling
  // back to the bottom, or the button, resumes it.
  const followRef = useRef(true);
  const [frozen, setFrozen] = useState(null);
  const [pending, setPending] = useState(0);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        setLogs(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        if (!followRef.current) setPending((n) => n + 1);
        setLogs((prev) => {
          const next = [...prev, msg.line];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "lines") {
        if (!followRef.current) setPending((n) => n + msg.lines.length);
        setLogs((prev) => {
          const next = [...prev, ...msg.lines];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        followRef.current = true;
        setFrozen(null);
        setLogs([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  const resume = () => { followRef.current = true; setFrozen(null); };
  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom === followRef.current) return;
    if (atBottom) { resume(); return; }
    followRef.current = false;
    setFrozen(logs);
    setPending(0);
  };
  const shown = frozen || logs;

  useEffect(() => {
    if (!logRef.current || !followRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [shown]);

  return (
    <div className="">
      <Card>
        <div className="flex items-center justify-end px-4 pt-3 pb-2">
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
        <div className="relative">
        <div
          ref={logRef}
          onScroll={onScroll}
          className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {shown.length === 0 ? (
            <span className="text-text-muted">No console logs yet.</span>
          ) : (
            <div className="space-y-0.5">
              {shown.map((line, i) => (
                <div key={i}>{colorLine(line)}</div>
              ))}
            </div>
          )}
        </div>
        {frozen && (
          <button
            type="button"
            onClick={resume}
            className="absolute bottom-4 right-6 flex items-center gap-1 rounded-full border border-white/15 bg-neutral-800/90 px-3 py-1.5 text-xs text-white shadow-lg hover:bg-neutral-700"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
            Paused{pending > 0 ? ` · ${pending} new` : ""} · jump to latest
          </button>
        )}
        </div>
      </Card>
    </div>
  );
}
