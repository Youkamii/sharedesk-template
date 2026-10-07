"use client";

import { apiPath } from "@/lib/client/api-path";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_BCP47, translate, type Locale } from "@/lib/i18n";
import { guestDisplayName } from "@/lib/nickname";
import type { NewBadgeState, OwnUploadIndex } from "@/lib/client/new-badges";
import {
  formatRecentTime,
  parseRecentResponse,
  recentActionLabel,
  recentItemIsNew,
  serverClockOffset,
} from "@/lib/client/recent-files-view";
import {
  DEFAULT_RECENT_DAYS,
  MAX_RECENT_LIMIT,
  RECENT_DAY_CHOICES,
  RECENT_REFRESH_MS,
  type RecentFileItem,
  type RecentFilesResponse,
} from "@/lib/recent-files";
import type { StorageSearchResult } from "@/lib/search";
import PixelFileIcon from "./PixelFileIcon";
import { folderAddress } from "./ui-scale";
import styles from "./desktop.module.css";

type Location = StorageSearchResult;

type Props = {
  locale: Locale;
  maximized: boolean;
  zIndex: number;
  active: boolean;
  // NEW 점(#16 C-2)과 같은 기록 — 데스크 화면이 들고 있는 것을 그대로 받는다.
  newBadges: NewBadgeState | null;
  ownUploads: OwnUploadIndex;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onActivate: () => void;
  // 위치 열기(단추·Enter) — 원래 자리(폴더 창·바탕화면)를 열고 그 항목을 고른다.
  onReveal: (location: Location, opener: HTMLElement) => void;
  // 두 번 누르기 — 데스크의 열기(미리보기·폴더 열기·내려받기)와 같은 흐름.
  onOpen: (location: Location, opener: HTMLElement) => void;
  onContextMenu: (event: React.MouseEvent, location: Location) => void;
  onKeyboardMenu: (target: HTMLElement, location: Location) => void;
};

const rowKey = (item: RecentFileItem) =>
  `${item.layoutKey}:${item.action}:${item.at}`;

export default function RecentFilesWindow({
  locale,
  maximized,
  zIndex,
  active,
  newBadges,
  ownUploads,
  onClose,
  onMinimize,
  onToggleMaximize,
  onActivate,
  onReveal,
  onOpen,
  onContextMenu,
  onKeyboardMenu,
}: Props) {
  const router = useRouter();
  const [days, setDays] = useState<number>(DEFAULT_RECENT_DAYS);
  const [data, setData] = useState<RecentFilesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 한 번 누르기는 줄을 고르기만 한다(데스크 아이콘과 같은 문법).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 서버 시각 − 브라우저 시각. "n분 전"은 서버 기록 시각과 견주므로 보정한다.
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const requestRef = useRef<AbortController | null>(null);
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  // quiet: 60초 갱신은 목록을 비우거나 "불러오는 중"을 띄우지 않고 바꿔 끼운다.
  const load = useCallback(
    async (requestedDays: number, quiet: boolean) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await fetch(
          apiPath(
            `/api/drive/recent?days=${requestedDays}&limit=${MAX_RECENT_LIMIT}`,
          ),
          { cache: "no-store", signal: controller.signal },
        );
        if (response.status === 401) {
          router.replace("/");
          return;
        }
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            typeof body?.error === "string"
              ? t(body.error)
              : t("최근 파일을 불러오지 못했습니다"),
          );
        }
        const parsed = parseRecentResponse(body);
        if (!parsed) throw new Error(t("최근 파일을 불러오지 못했습니다"));
        if (controller.signal.aborted) return;
        const receivedAt = Date.now();
        setClockOffset(serverClockOffset(parsed.now, receivedAt));
        setNow(receivedAt);
        setData(parsed);
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof Error
            ? caught.message
            : t("최근 파일을 불러오지 못했습니다"),
        );
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          setLoading(false);
        }
      }
    },
    [router, t],
  );

  // 열 때와 기간을 바꿀 때 새로 받는다.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(days, false), 0);
    return () => window.clearTimeout(timer);
  }, [load, days]);

  // 창이 열려 있는 동안만 60초마다 갱신한다 — 최소화·닫기면 이 컴포넌트가
  // 사라져 타이머도 함께 멈춘다. 탭이 숨어 있으면 건너뛴다.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load(days, true);
    }, RECENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, days]);

  useEffect(() => {
    return () => requestRef.current?.abort();
  }, []);

  const items = data?.items ?? [];
  const shownNow = now + clockOffset;

  return (
    <section
      className={`${styles.folderWindow} ${styles.shareLinksWindow} ${styles.recentFilesWindow} ${active ? styles.activeWindow : ""} ${maximized ? styles.utilityMaximized : ""}`}
      style={{ zIndex }}
      aria-label={t("최근 파일")}
      onPointerDown={onActivate}
    >
      <header className={styles.windowTitlebar}>
        <strong>{t("최근 파일")}</strong>
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
      <div className={styles.recentToolbar}>
        <div className={styles.recentChips} role="group" aria-label={t("기간")}>
          {RECENT_DAY_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={days === choice}
              className={days === choice ? styles.recentChipActive : ""}
              onClick={() => setDays(choice)}
            >
              {t("{count}일", { count: choice })}
            </button>
          ))}
        </div>
        <span className={styles.recentHint}>
          {t("두 번 누르면 열고, Enter나 위치 열기로 원래 자리를 엽니다")}
        </span>
      </div>
      <div className={styles.recentBody}>
        {loading && !data ? (
          <p role="status">{t("최근 파일을 불러오는 중입니다…")}</p>
        ) : items.length === 0 && !error ? (
          <p>
            {t("최근 {days}일 동안 올리거나 바꾼 파일이 없습니다.", { days })}
          </p>
        ) : (
          <ul className={styles.recentList}>
            {items.map((item) => {
              const key = rowKey(item);
              const selected = selectedKey === key;
              const location = item.location;
              const gone = item.exists === false;
              const isNew = recentItemIsNew(item, newBadges, ownUploads);
              const where = location
                ? folderAddress(location.breadcrumbs)
                : gone
                  ? t("지워짐")
                  : t("위치를 확인하지 못했습니다");
              const actor = item.actor.guest
                ? guestDisplayName(item.actor.name, t)
                : (item.actor.name ?? t("멤버"));
              const action =
                item.count > 1
                  ? `${t(recentActionLabel(item.action))} · ${t("{count}회", {
                      count: item.count,
                    })}`
                  : t(recentActionLabel(item.action));
              const at = Date.parse(item.at);
              const when = formatRecentTime(at, shownNow, locale, t);
              return (
                <li
                  key={key}
                  className={`${styles.recentRow} ${gone ? styles.recentGone : ""} ${
                    selected ? styles.recentSelected : ""
                  }`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (location) onContextMenu(event, location);
                  }}
                >
                  <button
                    type="button"
                    className={styles.recentMain}
                    aria-pressed={selected}
                    aria-label={`${item.name}, ${where}, ${action}, ${actor}, ${when}${
                      isNew ? `, ${t("새 파일")}` : ""
                    }`}
                    title={`${location ? `${location.path} · ` : ""}${new Date(
                      at,
                    ).toLocaleString(LOCALE_BCP47[locale])}`}
                    onClick={() => setSelectedKey(key)}
                    onDoubleClick={(event) => {
                      if (location) onOpen(location, event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      if (!location) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        setSelectedKey(key);
                        onReveal(location, event.currentTarget);
                      } else if (
                        event.key === "ContextMenu" ||
                        (event.shiftKey && event.key === "F10")
                      ) {
                        event.preventDefault();
                        onKeyboardMenu(event.currentTarget, location);
                      }
                    }}
                  >
                    <span className={styles.iconGlyph}>
                      <PixelFileIcon entry={item} size={32} />
                      {isNew && (
                        <span className={styles.newDot} aria-hidden="true" />
                      )}
                    </span>
                    <span className={styles.recentText}>
                      <strong>{item.name}</strong>
                      <span className={styles.recentPath}>{where}</span>
                    </span>
                    <span className={styles.recentMeta}>
                      <time dateTime={item.at}>{when}</time>
                      <span>{action}</span>
                      <span className={styles.recentActor}>{actor}</span>
                    </span>
                  </button>
                  {location && (
                    <button
                      type="button"
                      className={styles.recentReveal}
                      aria-label={t("{name} 위치 열기", { name: item.name })}
                      onClick={(event) => {
                        setSelectedKey(key);
                        onReveal(location, event.currentTarget);
                      }}
                    >
                      {t("위치 열기")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className={styles.windowStatus}>
        <span>
          {t("{count}개 항목", { count: items.length })}
          {data?.truncated ? ` · ${t("일부 위치는 확인하지 못했습니다")}` : ""}
        </span>
        <button
          type="button"
          onClick={() => void load(days, false)}
          disabled={loading}
        >
          {t("새로고침")}
        </button>
      </footer>
    </section>
  );
}
