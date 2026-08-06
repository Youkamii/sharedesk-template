"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function KeyForm() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoTried = useRef(false);

  async function submitKey(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });
      if (res.ok) {
        router.replace("/files");
        return;
      }
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "키가 올바르지 않습니다.");
    } catch {
      setError("서버에 연결할 수 없습니다.");
    }
    setBusy(false);
  }

  useEffect(() => {
    const urlKey = new URLSearchParams(window.location.search).get("key");
    if (urlKey && !autoTried.current) {
      autoTried.current = true;
      setKey(urlKey);
      void submitKey(urlKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submitKey(key);
      }}
    >
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="접속 키"
        className="rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />
      <button
        type="submit"
        disabled={busy || !key.trim()}
        className="rounded-lg border border-black/15 py-2 font-medium transition-opacity disabled:opacity-40 dark:border-white/20"
      >
        {busy ? "확인 중..." : "키로 입장"}
      </button>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
