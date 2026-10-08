"use client";

import { apiPath } from "@/lib/client/api-path";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import styles from "./desktop.module.css";

// CLI 연결 창(#34) — 멤버가 터미널·AI 에이전트용 토큰을 발급받는다. 토큰은
// 이 창에서 한 번만 보이고 서버는 저장하지 않는다. 구조·스타일은
// ShareLinkDialog를 따른다.

type Props = {
  locale: Locale;
  onClose: () => void;
  onNotice: (message: string) => void;
};

const panelStyle: CSSProperties = {
  display: "flex",
  width: "100%",
  flexDirection: "column",
  gap: 12,
  padding: 14,
  background: "#fff8e7",
  border: "2px solid #4f4853",
  boxShadow: "inset 2px 2px 0 #d8c7a5",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  minHeight: 40,
  padding: "7px 9px",
  color: "#1b1b2f",
  font: "inherit",
  background: "#fff8e7",
  border: "2px solid #4f4853",
  boxShadow: "inset 2px 2px 0 #b9aa8e",
};

const compactButtonStyle: CSSProperties = {
  minHeight: 36,
  padding: "6px 10px",
  border: "2px solid #10172b",
  whiteSpace: "nowrap",
};

const codeStyle: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  overflowX: "auto",
  color: "#1b1b2f",
  background: "#efe3c6",
  border: "2px solid #d8c7a5",
  fontFamily: "monospace",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre",
};

export default function CliTokenDialog({ locale, onClose, onNotice }: Props) {
  const router = useRouter();
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function issue() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiPath("/api/me/cli-token"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      if (response.status === 401) {
        router.replace("/");
        return;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok || typeof body?.token !== "string") {
        setError(
          typeof body?.error === "string" ? body.error : "토큰을 만들지 못했습니다",
        );
        return;
      }
      setToken(body.token);
    } catch {
      setError("토큰을 만들지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      onNotice(message);
    } catch {
      setError("아래 값을 직접 선택해 복사해 주세요");
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const loginCommand = token
    ? `node cli/sharedesk.mjs login ${origin} ${token}`
    : `node cli/sharedesk.mjs login ${origin} <토큰>`;

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        style={{
          display: "flex",
          width: "min(560px, 100%)",
          maxHeight: "calc(100dvh - 36px)",
          flexDirection: "column",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className={styles.dialogTitlebar}>
          <strong id={titleId}>{t("CLI 연결")}</strong>
          <button type="button" aria-label={t("닫기")} onClick={onClose}>
            ×
          </button>
        </header>

        <div
          className={styles.dialogBody}
          style={{
            alignItems: "stretch",
            overflowY: "auto",
            overscrollBehavior: "contain",
          }}
        >
          <p
            id={descriptionId}
            style={{
              width: "100%",
              padding: 12,
              color: "#31364a",
              background: "#e5eef0",
              border: "2px solid #51658d",
            }}
          >
            <span>
              {t("터미널이나 AI 에이전트가 이 데스크의 파일을 보고, 받고, 올릴 수 있는 토큰입니다.")}
            </span>
            <small>
              {t("토큰은 지금 한 번만 보입니다. 내 이름으로 동작하며, 관리자가 기기 세션에서 끊을 수 있습니다.")}
            </small>
          </p>

          {token ? (
            <div style={panelStyle}>
              <strong>{t("토큰이 준비됐습니다")}</strong>
              <input
                style={fieldStyle}
                readOnly
                value={token}
                aria-label={t("CLI 토큰")}
                onFocus={(event) => event.target.select()}
              />
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
                <button
                  type="button"
                  className={styles.primaryButton}
                  style={compactButtonStyle}
                  onClick={() => void copy(token, t("토큰을 복사했습니다."))}
                >
                  {t("토큰 복사")}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  style={compactButtonStyle}
                  onClick={() =>
                    void copy(loginCommand, t("로그인 명령을 복사했습니다."))
                  }
                >
                  {t("로그인 명령 복사")}
                </button>
              </div>
              <span>{t("저장소 폴더에서 이 명령으로 연결합니다:")}</span>
              <pre style={codeStyle}>{loginCommand}</pre>
              <span>{t("그 다음부터는 ls · get · put · mkdir 로 씁니다. 자세한 사용법은 docs/CLI.md 에 있습니다.")}</span>
            </div>
          ) : (
            <form
              style={panelStyle}
              aria-label={t("새 CLI 토큰")}
              onSubmit={(event) => {
                event.preventDefault();
                void issue();
              }}
            >
              <strong>{t("새 CLI 토큰")}</strong>
              <label>
                <span>{t("어디서 쓰는 토큰인지 (선택)")}</span>
                <input
                  style={fieldStyle}
                  value={label}
                  maxLength={74}
                  placeholder={t("예: 집 PC Claude")}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className={styles.primaryButton}
                style={{ ...compactButtonStyle, alignSelf: "flex-end" }}
                disabled={busy}
              >
                {busy ? t("만드는 중…") : t("토큰 만들기")}
              </button>
            </form>
          )}

          {error && (
            <p
              role="alert"
              style={{
                width: "100%",
                padding: 10,
                color: "#7d2632",
                background: "#f8d9d3",
                border: "2px solid #a53c46",
              }}
            >
              {t(error)}
            </p>
          )}

          <div className={styles.dialogActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onClose}
            >
              {t("닫기")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
