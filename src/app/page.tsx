"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
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
      setError("키가 올바르지 않습니다.");
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
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 p-8 shadow-sm dark:border-white/15">
        <h1 className="text-2xl font-semibold tracking-tight">ShareDesk</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          키를 입력하면 공유 드라이브가 열립니다.
        </p>
        <form
          className="mt-6 flex flex-col gap-3"
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
            autoFocus
            className="rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
          />
          <button
            type="submit"
            disabled={busy || !key.trim()}
            className="rounded-lg bg-foreground py-2 font-medium text-background transition-opacity disabled:opacity-40"
          >
            {busy ? "확인 중..." : "입장"}
          </button>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </form>
      </div>
    </main>
  );
}
