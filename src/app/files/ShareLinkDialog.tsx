"use client";

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_BCP47, translate, type Locale } from "@/lib/i18n";
import styles from "./desktop.module.css";

// 외부 공유 링크 관리 창 — 만료 기간을 골라 링크를 만들고, 복사하고,
// 활성 링크를 거둔다. 구조·스타일은 ShareDialog(드라이브 공유)를 따른다.

// 서버 lib의 타입을 그대로 쓴다 — type-only import라 서버 코드는 번들에
// 딸려 오지 않는다.
import type { ShareLink } from "@/lib/share-links";

type ShareLinkDialogProps = {
  entry: {
    id: string;
    name: string;
  };
  locale: Locale;
  onClose: () => void;
  onNotice: (message: string) => void;
};

const EXPIRY_CHOICES = [
  { hours: 1, label: "1시간" },
  { hours: 24, label: "24시간" },
  { hours: 24 * 7, label: "7일" },
  { hours: 24 * 30, label: "30일" },
] as const;

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

function isShareLink(value: unknown): value is ShareLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<ShareLink>;
  return (
    typeof link.linkId === "string" &&
    typeof link.fileId === "string" &&
    typeof link.name === "string" &&
    typeof link.createdBy === "string" &&
    typeof link.createdAt === "string" &&
    typeof link.expiresAt === "string"
  );
}

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

function isAbortError(value: unknown) {
  return value instanceof DOMException && value.name === "AbortError";
}

function shareUrl(linkId: string) {
  return `${window.location.origin}/api/share/${linkId}`;
}

export default function ShareLinkDialog({
  entry,
  locale,
  onClose,
  onNotice,
}: ShareLinkDialogProps) {
  const router = useRouter();
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [expiresInHours, setExpiresInHours] = useState<number>(24 * 7);
  // 방금 만든 링크 — 복사 상자를 목록과 별도로 크게 보여 준다.
  const [createdLinkId, setCreatedLinkId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const apiJson = useCallback(
    async function apiJson<T>(pathname: string, init: RequestInit): Promise<T> {
      const response = await fetch(pathname, init);
      if (response.status === 401) {
        router.replace("/");
        throw new Error("세션이 만료되었습니다");
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "요청에 실패했습니다");
      }
      return body as T;
    },
    [router],
  );

  const loadLinks = useCallback(
    async (showLoading = true) => {
      loadControllerRef.current?.abort();
      const controller = new AbortController();
      loadControllerRef.current = controller;
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const body = await apiJson<{ links: unknown }>(
          `/api/drive/share-link?fileId=${encodeURIComponent(entry.id)}`,
          { method: "GET", cache: "no-store", signal: controller.signal },
        );
        if (loadControllerRef.current !== controller) return;
        setLinks(
          Array.isArray(body.links) ? body.links.filter(isShareLink) : [],
        );
      } catch (loadError) {
        if (
          isAbortError(loadError) ||
          loadControllerRef.current !== controller
        ) {
          return;
        }
        setError(errorMessage(loadError, "공유 링크를 불러오지 못했습니다"));
      } finally {
        if (loadControllerRef.current === controller) setLoading(false);
      }
    },
    [apiJson, entry.id],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLinks(), 0);
    return () => {
      window.clearTimeout(timer);
      loadControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
    };
  }, [loadLinks]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const busy = busyKey !== null;

  function closeDialog() {
    loadControllerRef.current?.abort();
    mutationControllerRef.current?.abort();
    onClose();
  }

  async function createLink() {
    if (busy) return;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusyKey("create");
    setError(null);
    try {
      const body = await apiJson<{ link: unknown }>("/api/drive/share-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, expiresInHours }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted && isShareLink(body.link)) {
        setCreatedLinkId(body.link.linkId);
      }
      await loadLinks(false);
    } catch (mutationError) {
      if (!controller.signal.aborted && !isAbortError(mutationError)) {
        setError(errorMessage(mutationError, "공유 링크를 만들지 못했습니다"));
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        if (!controller.signal.aborted) setBusyKey(null);
      }
    }
  }

  async function copyLink(linkId: string) {
    try {
      await navigator.clipboard.writeText(shareUrl(linkId));
      onNotice(t("공유 링크를 복사했습니다."));
    } catch {
      // 클립보드가 막힌 브라우저 — 주소 상자를 직접 선택하도록 안내한다.
      setCreatedLinkId(linkId);
      setError("아래 주소를 직접 선택해 복사해 주세요");
    }
  }

  async function revokeLink(link: ShareLink) {
    if (busy) return;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusyKey(`revoke:${link.linkId}`);
    setError(null);
    try {
      const result = await apiJson<{ ok?: boolean }>("/api/drive/share-link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId: link.linkId }),
        signal: controller.signal,
      });
      if (createdLinkId === link.linkId) setCreatedLinkId(null);
      await loadLinks(false);
      if (!controller.signal.aborted) {
        // ok:false는 이미 만료·취소된 링크 — 성공처럼 알리지 않는다.
        onNotice(
          result?.ok === false
            ? t("이미 만료되었거나 취소된 링크입니다.")
            : t("공유 링크를 취소했습니다. 이제 그 링크로는 받을 수 없습니다."),
        );
      }
    } catch (mutationError) {
      if (!controller.signal.aborted && !isAbortError(mutationError)) {
        setError(errorMessage(mutationError, "공유 링크를 취소하지 못했습니다"));
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        if (!controller.signal.aborted) setBusyKey(null);
      }
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (activeIndex === -1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function formatExpiry(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(LOCALE_BCP47[locale], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : value;
  }

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
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
          <strong id={titleId}>{t("공유 링크")}</strong>
          <button type="button" aria-label={t("닫기")} onClick={closeDialog}>
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
          <strong style={{ overflowWrap: "anywhere" }}>‘{entry.name}’</strong>

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
              {t("링크를 아는 사람은 로그인 없이 이 파일 하나만 내려받을 수 있습니다.")}
            </span>
            <small>
              {t("정한 기간이 지나면 링크는 저절로 만료되고, 언제든 먼저 취소할 수도 있습니다.")}
            </small>
          </p>

          {loading ? (
            <p role="status" style={{ width: "100%", paddingBlock: 18 }}>
              {t("공유 링크를 불러오는 중입니다…")}
            </p>
          ) : (
            <>
              <form
                style={panelStyle}
                aria-label={t("새 공유 링크")}
                onSubmit={(event) => {
                  event.preventDefault();
                  void createLink();
                }}
              >
                <strong>{t("새 공유 링크")}</strong>
                <label>
                  <span>{t("만료 기간")}</span>
                  <select
                    style={fieldStyle}
                    value={expiresInHours}
                    disabled={busy}
                    onChange={(event) =>
                      setExpiresInHours(Number(event.target.value))
                    }
                  >
                    {EXPIRY_CHOICES.map((choice) => (
                      <option key={choice.hours} value={choice.hours}>
                        {t(choice.label)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className={styles.primaryButton}
                  style={{ ...compactButtonStyle, alignSelf: "flex-end" }}
                  disabled={busy}
                >
                  {busyKey === "create" ? t("만드는 중…") : t("링크 만들기")}
                </button>
              </form>

              {createdLinkId && (
                <div style={panelStyle}>
                  <strong>{t("링크가 준비됐습니다")}</strong>
                  <input
                    style={fieldStyle}
                    readOnly
                    value={shareUrl(createdLinkId)}
                    aria-label={t("공유 링크 주소")}
                    onFocus={(event) => event.target.select()}
                  />
                  <button
                    type="button"
                    className={styles.primaryButton}
                    style={{ ...compactButtonStyle, alignSelf: "flex-end" }}
                    onClick={() => void copyLink(createdLinkId)}
                  >
                    {t("복사")}
                  </button>
                </div>
              )}

              <section style={panelStyle} aria-labelledby={`${titleId}-links`}>
                <strong id={`${titleId}-links`}>{t("활성 링크")}</strong>
                {links.length === 0 ? (
                  <span style={{ color: "#666b78", lineHeight: 1.5 }}>
                    {t("이 파일의 활성 링크가 없습니다.")}
                  </span>
                ) : (
                  <ul
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      margin: 0,
                      padding: 0,
                      listStyle: "none",
                    }}
                  >
                    {links.map((link) => (
                      <li
                        key={link.linkId}
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: 8,
                          paddingTop: 10,
                          borderTop: "2px solid #d8c7a5",
                        }}
                      >
                        <span
                          style={{
                            display: "flex",
                            minWidth: 0,
                            flex: "1 1 200px",
                            flexDirection: "column",
                            gap: 3,
                            overflowWrap: "anywhere",
                          }}
                        >
                          <strong>
                            {t("{time} 만료", {
                              time: formatExpiry(link.expiresAt),
                            })}
                          </strong>
                          <small style={{ color: "#666b78" }}>
                            {t("{name}님이 만듦", { name: link.createdBy })}
                          </small>
                        </span>
                        <span
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            justifyContent: "flex-end",
                            gap: 6,
                          }}
                        >
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            style={compactButtonStyle}
                            disabled={busy}
                            onClick={() => void copyLink(link.linkId)}
                          >
                            {t("복사")}
                          </button>
                          <button
                            type="button"
                            className={styles.dangerButton}
                            style={compactButtonStyle}
                            disabled={busy}
                            onClick={() => void revokeLink(link)}
                          >
                            {busyKey === `revoke:${link.linkId}`
                              ? t("취소 중…")
                              : t("링크 취소")}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
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
              onClick={closeDialog}
            >
              {t("닫기")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
