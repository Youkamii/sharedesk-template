"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import auth from "./auth.module.css";

export default function KeyForm({ locale }: { locale: Locale }) {
  const router = useRouter();
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);
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

  // 모양은 공용 도트 카드(auth.module.css)가 정한다 — 부모가 .authForm으로 감싸면
  // 입력·단추가 픽셀 프레임이 된다(위젯·웹 공통, #6).
  return (
    <form
      className={auth.keyForm}
      onSubmit={(e) => {
        e.preventDefault();
        void submitKey(key);
      }}
    >
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={t("접속 키")}
        aria-label={t("접속 키")}
      />
      <button type="submit" disabled={busy || !key.trim()}>
        {busy ? t("확인 중...") : t("키로 입장")}
      </button>
      {error && <p>{t(error)}</p>}
    </form>
  );
}
