"use client";

import { apiPath } from "@/lib/client/api-path";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_BCP47, translate, type Locale } from "@/lib/i18n";
import type { ShareLink } from "@/lib/share-links";
import ShareOutButton from "../ShareOutButton";
import QrCodeToggle from "../QrCodeToggle";
import styles from "./desktop.module.css";

type Props = {
  locale: Locale;
  maximized: boolean;
  zIndex: number;
  active: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  linksRevision: number;
  onLinksChanged: () => void;
  onNotice: (message: string) => void;
  onActivate: () => void;
};

function isShareLink(value: unknown): value is ShareLink {
  const link = value as Partial<ShareLink> | null;
  return (
    !!link &&
    typeof link.linkId === "string" &&
    typeof link.fileId === "string" &&
    typeof link.name === "string" &&
    typeof link.createdBy === "string" &&
    typeof link.expiresAt === "string"
  );
}

export default function ShareLinksWindow({
  locale,
  maximized,
  zIndex,
  active,
  onClose,
  onMinimize,
  onToggleMaximize,
  linksRevision,
  onLinksChanged,
  onNotice,
  onActivate,
}: Props) {
  const router = useRouter();
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiPath("/api/drive/share-link"), {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.replace("/");
        return;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string"
            ? t(body.error)
            : t("공유 링크를 불러오지 못했습니다"),
        );
      }
      setLinks(Array.isArray(body?.links) ? body.links.filter(isShareLink) : []);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("공유 링크를 불러오지 못했습니다"),
      );
    } finally {
      setLoading(false);
    }
  }, [router, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, linksRevision]);

  async function copy(link: ShareLink) {
    const url = `${window.location.origin}/api/share/${link.linkId}`;
    try {
      await navigator.clipboard.writeText(url);
      onNotice(t("공유 링크를 복사했습니다."));
    } catch {
      onNotice(url);
    }
  }

  async function revoke(link: ShareLink) {
    if (busyId) return;
    setBusyId(link.linkId);
    setError(null);
    try {
      const response = await fetch(apiPath("/api/drive/share-link"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId: link.linkId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string"
            ? t(body.error)
            : t("공유를 멈추지 못했습니다"),
        );
      }
      setLinks((current) => current.filter((item) => item.linkId !== link.linkId));
      onLinksChanged();
      onNotice(t("공유 링크를 멈췄습니다."));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("공유를 멈추지 못했습니다"),
      );
    } finally {
      setBusyId(null);
    }
  }

  function formatDate(value: string) {
    return new Date(value).toLocaleString(LOCALE_BCP47[locale], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <section
      className={`${styles.folderWindow} ${styles.shareLinksWindow} ${active ? styles.activeWindow : ""} ${maximized ? styles.utilityMaximized : ""}`}
      style={{ zIndex }}
      aria-label={t("생성된 링크")}
      onPointerDown={onActivate}
    >
      <header className={styles.windowTitlebar}>
        <strong>{t("생성된 링크")}</strong>
        <span className={styles.windowControls}>
          <button type="button" aria-label={t("최소화")} onClick={onMinimize}>
            <span className={styles.minimizeGlyph} />
          </button>
          <button
            type="button"
            aria-label={maximized ? t("복원") : t("최대화")}
            onClick={onToggleMaximize}
          >
            <span className={styles.maximizeGlyph} />
          </button>
          <button type="button" aria-label={t("닫기")} onClick={onClose}>
            <span className={styles.closeGlyph} />
          </button>
        </span>
      </header>
      <div className={styles.shareLinksBody}>
        {loading ? (
          <p role="status">{t("공유 링크를 불러오는 중입니다…")}</p>
        ) : links.length === 0 ? (
          <p>{t("현재 공유 중인 링크가 없습니다.")}</p>
        ) : (
          <ul>
            {links.map((link) => (
              <li key={link.linkId}>
                <span>
                  <strong>{link.kind === "folder" ? "▣ " : "▪ "}{link.name}</strong>
                  <small>
                    {t("{name}님이 만듦", { name: link.createdBy })}
                    {" · "}
                    {t("{time} 만료", { time: formatDate(link.expiresAt) })}
                  </small>
                </span>
                <span>
                  <button type="button" onClick={() => void copy(link)}>
                    {t("복사")}
                  </button>
                  <ShareOutButton
                    url={`${window.location.origin}/api/share/${link.linkId}`}
                    title={link.name}
                    label={t("공유")}
                    onOutcome={(outcome) => {
                      if (outcome === "copied") {
                        onNotice(t("공유 링크를 복사했습니다."));
                      } else if (outcome === "manual") {
                        onNotice(
                          `${window.location.origin}/api/share/${link.linkId}`,
                        );
                      }
                    }}
                  />
                  <QrCodeToggle
                    value={`${window.location.origin}/api/share/${link.linkId}`}
                    label="QR"
                    closeLabel={t("닫기")}
                  />
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={busyId !== null}
                    onClick={() => void revoke(link)}
                  >
                    {busyId === link.linkId ? t("멈추는 중…") : t("공유 멈추기")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className={styles.windowStatus}>
        <span>{t("활성 링크 {count}개", { count: links.length })}</span>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {t("새로고침")}
        </button>
      </footer>
    </section>
  );
}
