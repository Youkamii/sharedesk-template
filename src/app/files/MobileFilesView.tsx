"use client";

import { apiPath } from "@/lib/client/api-path";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import {
  formatSize,
  sortEntries,
  type MobileEntry,
} from "@/lib/client/mobile-listing";
import LogoutButton from "../LogoutButton";
import PixelFileIcon from "./PixelFileIcon";
import styles from "./mobile.module.css";

// 데스크탑은 1280x720 논리 좌표를 화면 크기에 맞춰 축소한다. 좁은 화면에서는
// 그 배율이 0.3까지 떨어져 글자를 읽을 수 없으므로, 자유 배치 캔버스를 접고
// 세로 목록으로 바꾼다. 넓은 화면은 기존 데스크탑을 그대로 쓴다.

type Props = {
  locale: Locale;
  rootId: string;
  allowUpload: boolean;
  // 손님은 스페이스 선택(/spaces)에 갈 수 없어 로그아웃만 보인다(#14).
  isGuest?: boolean;
};

// 들어온 폴더를 쌓아 두고 뒤로가기로 하나씩 벗긴다.
type Crumb = { id: string; name: string };

export default function MobileFilesView({
  locale,
  rootId,
  allowUpload,
  isGuest = false,
}: Props) {
  const router = useRouter();
  const [trail, setTrail] = useState<Crumb[]>([]);
  // 불러온 폴더를 함께 담아 둔다. "지금 폴더와 다르면 로딩"으로 파생시키면
  // 효과 본문에서 동기 setState를 하지 않아도 된다.
  const [loaded, setLoaded] = useState<{
    folderId: string;
    entries: MobileEntry[];
    error: string | null;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<{ text: string; kind: "info" | "error" } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  const currentId = trail.length > 0 ? trail[trail.length - 1].id : rootId;
  const currentName =
    trail.length > 0 ? trail[trail.length - 1].name : t("공유 바탕화면");

  const loading = loaded?.folderId !== currentId;
  const entries = loading ? [] : (loaded?.entries ?? []);
  const error = loading ? null : (loaded?.error ?? null);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    // 늦게 도착한 옛 응답이 새 폴더를 덮지 않게 한다.
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(
          apiPath(`/api/drive/list?folderId=${encodeURIComponent(currentId)}`),
          { cache: "no-store" },
        );
        if (!alive) return;
        if (response.status === 401) {
          router.replace("/");
          return;
        }
        if (!response.ok) throw new Error("list");
        const body = (await response.json()) as { entries: MobileEntry[] };
        if (!alive) return;
        setLoaded({
          folderId: currentId,
          entries: sortEntries(body.entries ?? []),
          error: null,
        });
      } catch {
        if (!alive) return;
        setLoaded({
          folderId: currentId,
          entries: [],
          error: t("목록을 불러오지 못했습니다"),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [currentId, reloadKey, router, t]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  function openEntry(entry: MobileEntry) {
    if (entry.isFolder) {
      setTrail((current) => [...current, { id: entry.id, name: entry.name }]);
      return;
    }
    // 모바일에서는 창을 띄우는 대신 브라우저에 맡긴다 — 이미지·PDF는 바로
    // 열리고 나머지는 내려받는다.
    window.open(
      apiPath(`/api/drive/download?id=${encodeURIComponent(entry.id)}&disposition=inline`),
      "_blank",
      "noopener,noreferrer",
    );
  }

  function goUp() {
    setTrail((current) => current.slice(0, -1));
  }

  async function createFolder() {
    const name = window.prompt(t("새 폴더 이름"));
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(apiPath("/api/drive/mkdir"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), parentId: currentId }),
      });
      if (!response.ok) throw new Error("mkdir");
      setNotice({ text: t("폴더를 만들었습니다."), kind: "info" });
      reload();
    } catch {
      setNotice({ text: t("폴더를 만들지 못했습니다"), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files: FileList) {
    setBusy(true);
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        const response = await fetch(
          apiPath(`/api/drive/upload?parentId=${encodeURIComponent(currentId)}&name=${encodeURIComponent(file.name)}`),
          {
            method: "POST",
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "Content-Length": String(file.size),
            },
            body: file,
          },
        );
        if (!response.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setNotice(
      failed === 0
        ? { text: t("올렸습니다."), kind: "info" }
        : {
            text: t("{count}개를 올리지 못했습니다.", { count: failed }),
            kind: "error",
          },
    );
    reload();
  }

  return (
    <main className={styles.screen}>
      <header className={styles.bar}>
        {trail.length > 0 ? (
          <button
            type="button"
            className={styles.backButton}
            onClick={goUp}
            aria-label={t("뒤로")}
          >
            ◀
          </button>
        ) : (
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <strong className={styles.title}>{currentName}</strong>
        {/* 목록 화면에는 작업표시줄이 없다. 나갈 길을 상단에 둔다 — 데스크
            밖으로 나가는 문은 스페이스 선택 하나(로그아웃은 그 화면에),
            손님만 로그아웃 직행이다(#14). */}
        {isGuest ? (
          <LogoutButton locale={locale} className={styles.logoutButton} />
        ) : (
          <a href="/spaces" className={styles.logoutButton}>
            {t("나가기")}
          </a>
        )}
      </header>

      {notice && (
        <p
          className={notice.kind === "error" ? styles.error : styles.notice}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <ul className={styles.list}>
        {loading ? (
          <li className={styles.empty} role="status">
            {t("불러오는 중입니다…")}
          </li>
        ) : entries.length === 0 ? (
          <li className={styles.empty}>{t("이 폴더는 비어 있습니다.")}</li>
        ) : (
          entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={styles.row}
                onClick={() => openEntry(entry)}
              >
                <span className={styles.rowIcon} aria-hidden="true">
                  <PixelFileIcon entry={entry} size={28} />
                </span>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{entry.name}</span>
                  {!entry.isFolder && entry.size !== null && (
                    <span className={styles.rowMeta}>
                      {formatSize(entry.size)}
                    </span>
                  )}
                </span>
                {entry.isFolder && (
                  <span className={styles.rowChevron} aria-hidden="true">
                    ▶
                  </span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>

      {allowUpload && (
        <nav className={styles.dock}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <span aria-hidden="true">⬆</span>
            {t("올리기")}
          </button>
          <button type="button" onClick={createFolder} disabled={busy}>
            <span aria-hidden="true">＋</span>
            {t("새 폴더")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className={styles.hiddenInput}
            onChange={(event) => {
              if (event.target.files?.length) {
                void uploadFiles(event.target.files);
              }
              event.target.value = "";
            }}
          />
        </nav>
      )}
    </main>
  );
}
