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
import {
  startUploadReservationHeartbeat,
  uploadWithProgress,
} from "@/lib/client/transfer";
import { NOTICE_DURATION_MS } from "@/lib/client/use-auto-dismiss-notice";
import { FOLDER_COLOR_IDS } from "@/lib/folder-color-ids";
import LogoutButton from "../LogoutButton";
import PixelFileIcon from "./PixelFileIcon";
import styles from "./mobile.module.css";

// 데스크탑과 같은 업로드 세션. drive 모드는 direct(브라우저 → 드라이브 직행),
// local 모드는 proxy(서버 경유)를 준다.
type UploadSession =
  | { mode: "direct"; url: string; reservationId?: string }
  | { mode: "proxy"; reservationId?: string };

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

// 검색 결과 한 줄 — 서버 StorageSearchResult의 부분집합(#15 A-3).
type SearchHit = {
  entry: MobileEntry;
  breadcrumbs: Crumb[];
  path: string;
};

// 색 이름은 사전 키(빨강·주황·…)와 같다 — 데스크톱 스와치와 동일 문구.
const FOLDER_COLOR_LABELS: Record<string, string> = {
  red: "빨강",
  orange: "주황",
  yellow: "노랑",
  green: "초록",
  blue: "파랑",
  indigo: "남색",
  violet: "보라",
};

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
  // 업로드 진행 표시(#14) — 폰에서는 지금 뭐가 올라가는 중인지 눈에 보여야
  // 한다. 진행 없이 조용하면 사용자는 실패인지 진행 중인지 알 길이 없다.
  const [progress, setProgress] = useState<{
    name: string;
    current: number;
    total: number;
    percent: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 카메라 직결(#15 A-2). 갤러리 저장을 거치지 않고 찍자마자 올린다.
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // 전체 검색(#15 A-3). 서버(search.ts)는 완성돼 있고 화면만 얹는다.
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<
    | { status: "loading"; query: string }
    | {
        status: "done";
        query: string;
        results: SearchHit[];
        truncated: boolean;
      }
    | { status: "error"; query: string }
    | null
  >(null);
  const searchSeqRef = useRef(0);
  // 롱프레스 액션 시트(#15 A-1). 폰에는 우클릭이 없다 — 길게 누르면
  // 파일 정리 동작이 올라온다.
  const [sheet, setSheet] = useState<MobileEntry | null>(null);
  const [sheetInfo, setSheetInfo] = useState<{
    uploadedBy: string | null;
    uploadedAt: string | null;
    downloadCount: number | null;
    size: number | null;
    modifiedAt: string | null;
  } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

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
    // 오류는 저절로 사라지지 않는다 — 폰에서는 화면을 안 보고 있는 사이에
    // 사라지면 실패한 줄도 모른다. 눌러서 닫는다.
    if (!notice || notice.kind === "error") return;
    const timer = setTimeout(
      () => setNotice(null),
      NOTICE_DURATION_MS.default,
    );
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

  // 검색은 제출 시 1회 — 폰에서 타이핑마다 전체 트리를 훑게 하면 서버의
  // 탐색 예산만 태운다.
  async function runSearch(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query) return;
    const seq = ++searchSeqRef.current;
    setSearchState({ status: "loading", query });
    try {
      const response = await fetch(
        apiPath(
          `/api/drive/search?query=${encodeURIComponent(query)}&folderId=${encodeURIComponent(rootId)}`,
        ),
        { cache: "no-store" },
      );
      if (response.status === 401) {
        router.replace("/");
        return;
      }
      if (!response.ok) throw new Error("search");
      const body = (await response.json()) as {
        results?: SearchHit[];
        truncated?: boolean;
      };
      if (searchSeqRef.current !== seq) return; // 늦은 응답은 버린다
      setSearchState({
        status: "done",
        query,
        results: body.results ?? [],
        truncated: body.truncated === true,
      });
    } catch {
      if (searchSeqRef.current !== seq) return;
      setSearchState({ status: "error", query });
    }
  }

  function closeSearch() {
    searchSeqRef.current += 1;
    setSearchMode(false);
    setSearchQuery("");
    setSearchState(null);
  }

  // 서버 breadcrumbs의 첫 칸은 루트(ShareDesk)다 — trail은 루트를 뺀다.
  function goToCrumbs(crumbs: Crumb[]) {
    setTrail(crumbs.slice(1));
    closeSearch();
  }

  async function mobileJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiPath(path), init);
    if (response.status === 401) {
      router.replace("/");
      throw new Error(t("세션이 만료되었습니다"));
    }
    const parsed = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new Error(
        typeof parsed?.error === "string"
          ? t(parsed.error)
          : t("요청에 실패했습니다"),
      );
    }
    return parsed as T;
  }

  // 길게 누르면(500ms) 시트, 움직이면 취소. 안드로이드는 롱프레스가
  // contextmenu로도 오므로 함께 받는다. 발동 직후의 click은 삼킨다.
  function longPressProps(entry: MobileEntry) {
    const cancel = () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
    return {
      onPointerDown: () => {
        suppressClickRef.current = false;
        cancel();
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null;
          suppressClickRef.current = true;
          setSheet(entry);
        }, 500);
      },
      onPointerUp: cancel,
      onPointerMove: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (event: { preventDefault(): void }) => {
        event.preventDefault();
        cancel();
        suppressClickRef.current = true;
        setSheet(entry);
      },
    };
  }

  function consumeLongPress(): boolean {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }

  function closeSheet() {
    setSheet(null);
    setSheetInfo(null);
  }

  async function sheetRun(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setNotice({
        text:
          error instanceof Error ? error.message : t("요청에 실패했습니다"),
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  function sheetRename(entry: MobileEntry) {
    const name = window.prompt(t("새 이름"), entry.name)?.trim();
    if (!name || name === entry.name) return;
    void sheetRun(async () => {
      await mobileJson("/api/drive/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 서버는 낙관적 잠금(expectedVersion)을 요구한다 — 목록 응답의
        // version을 그대로 넘긴다.
        body: JSON.stringify({
          id: entry.id,
          name,
          expectedVersion: entry.version,
        }),
      });
      closeSheet();
      setNotice({ text: t("이름을 바꿨습니다"), kind: "info" });
      reload();
    });
  }

  function sheetTrash(entry: MobileEntry) {
    if (!window.confirm(`${entry.name} — ${t("휴지통에 넣을까요?")}`)) return;
    void sheetRun(async () => {
      await mobileJson("/api/drive/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      closeSheet();
      setNotice({
        text: t("‘{name}’을 휴지통에 넣었습니다", { name: entry.name }),
        kind: "info",
      });
      reload();
    });
  }

  // 이동은 폴더 픽커 대신 "상위 폴더로"만 — 폰에서 가장 흔한 정리 동선이고
  // 목록 응답의 version(낙관적 잠금)만으로 끝난다.
  function sheetMoveUp(entry: MobileEntry) {
    const parentId = trail.length >= 2 ? trail[trail.length - 2].id : rootId;
    void sheetRun(async () => {
      await mobileJson("/api/drive/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          targetFolderId: parentId,
          expectedVersion: entry.version,
        }),
      });
      closeSheet();
      setNotice({ text: t("상위 폴더로 옮겼습니다"), kind: "info" });
      reload();
    });
  }

  function sheetQuickLink(entry: MobileEntry) {
    void sheetRun(async () => {
      const body = await mobileJson<{ link?: { linkId?: string } }>(
        "/api/drive/share-link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: entry.id, expiresInHours: 1 }),
        },
      );
      if (!body.link?.linkId) throw new Error(t("공유 링크를 만들지 못했습니다"));
      const url = `${window.location.origin}/api/share/${body.link.linkId}`;
      closeSheet();
      try {
        await navigator.clipboard.writeText(url);
        setNotice({
          text: t("1시간 공유 링크를 만들어 복사했습니다."),
          kind: "info",
        });
      } catch {
        setNotice({ text: url, kind: "info" });
      }
    });
  }

  function sheetColor(entry: MobileEntry, color: string | null) {
    void sheetRun(async () => {
      await mobileJson("/api/desktop/folder-color", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, color }),
      });
      closeSheet();
      reload();
    });
  }

  function sheetProperties(entry: MobileEntry) {
    void sheetRun(async () => {
      const data = await mobileJson<{
        entry: { size: number | null; modifiedAt: string | null };
        uploadedBy: string | null;
        uploadedAt: string | null;
        downloadCount: number | null;
      }>(`/api/drive/properties?id=${encodeURIComponent(entry.id)}`, {
        cache: "no-store",
      });
      setSheetInfo({
        uploadedBy: data.uploadedBy,
        uploadedAt: data.uploadedAt,
        downloadCount: data.downloadCount,
        size: data.entry.size,
        modifiedAt: data.entry.modifiedAt,
      });
    });
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

  async function uploadSessionJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(apiPath(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      router.replace("/");
      throw new Error(t("세션이 만료되었습니다"));
    }
    const parsed = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new Error(
        typeof parsed?.error === "string"
          ? t(parsed.error)
          : t("업로드에 실패했습니다"),
      );
    }
    return parsed as T;
  }

  // 데스크탑(FilesView)과 같은 경로로 올린다. 예전에는 파일 전체를 앱 서버로
  // POST했는데, 드라이브 모드에서 그건 어댑터가 "API를 직접 호출하는
  // 클라이언트를 위한 폴백"이라고 못박은 길이다. 서버리스 배포에서는 요청
  // 본문 상한에 걸려 큰 사진이 그대로 실패한다 — 폰 사진이 딱 그 크기다.
  async function uploadOne(
    file: File,
    onProgress: (sent: number, total: number) => void,
  ) {
    const mimeType = file.type || "application/octet-stream";
    const session = await uploadSessionJson<UploadSession>(
      "/api/drive/upload-session",
      { parentId: currentId, name: file.name, mimeType, size: file.size },
    );
    if (session.mode === "direct") {
      const stopHeartbeat = startUploadReservationHeartbeat(
        session.reservationId,
      );
      try {
        const uploaded = await uploadWithProgress(
          session.url,
          "PUT",
          file,
          null,
          onProgress,
        );
        if (uploaded.status < 200 || uploaded.status >= 300) {
          throw new Error(t("드라이브 업로드에 실패했습니다"));
        }
        const body = JSON.parse(uploaded.responseText || "null") as {
          id?: string;
        } | null;
        if (session.reservationId && body?.id) {
          await uploadSessionJson("/api/drive/upload-complete", {
            reservationId: session.reservationId,
            fileId: body.id,
          });
        }
        return;
      } finally {
        stopHeartbeat();
      }
    }
    const reservationQuery = session.reservationId
      ? `&reservationId=${encodeURIComponent(session.reservationId)}`
      : "";
    const uploaded = await uploadWithProgress(
      apiPath(
        `/api/drive/upload?parentId=${encodeURIComponent(currentId)}&name=${encodeURIComponent(file.name)}${reservationQuery}`,
      ),
      "POST",
      file,
      mimeType,
      onProgress,
    );
    if (uploaded.status === 401) {
      router.replace("/");
      throw new Error(t("세션이 만료되었습니다"));
    }
    if (uploaded.status < 200 || uploaded.status >= 300) {
      const body = JSON.parse(uploaded.responseText || "null") as {
        error?: string;
      } | null;
      throw new Error(
        typeof body?.error === "string"
          ? t(body.error)
          : t("업로드에 실패했습니다"),
      );
    }
  }

  async function uploadFiles(files: FileList) {
    setBusy(true);
    setNotice(null);
    // 서버가 알려 준 이유를 그대로 보여준다. 예전에는 실패 개수만 세서
    // "왜 안 되는지"를 화면에서 알 수 없었다.
    const failures: string[] = [];
    const list = Array.from(files);
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index];
      setProgress({
        name: file.name,
        current: index + 1,
        total: list.length,
        percent: 0,
      });
      try {
        await uploadOne(file, (sent, total) => {
          const percent =
            total > 0
              ? Math.min(100, Math.round((sent / total) * 100))
              : 0;
          setProgress({
            name: file.name,
            current: index + 1,
            total: list.length,
            percent,
          });
        });
      } catch (error) {
        failures.push(
          `${file.name}: ${
            error instanceof Error ? error.message : t("실패")
          }`,
        );
      }
    }
    setProgress(null);
    setBusy(false);
    setNotice(
      failures.length === 0
        ? { text: t("올렸습니다."), kind: "info" }
        : {
            text: t("올리지 못했습니다 · {failures}", {
              failures: failures.join(" / "),
            }),
            kind: "error",
          },
    );
    reload();
  }

  return (
    <main className={styles.screen}>
      <header className={styles.bar}>
        {searchMode ? (
          <>
            <button
              type="button"
              className={styles.backButton}
              onClick={closeSearch}
              aria-label={t("검색 닫기")}
            >
              ✕
            </button>
            <form
              className={styles.searchForm}
              onSubmit={(event) => {
                event.preventDefault();
                void runSearch(searchQuery);
              }}
            >
              <input
                type="search"
                value={searchQuery}
                placeholder={t("파일 검색")}
                aria-label={t("전체 파일 검색어")}
                spellCheck={false}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <button type="submit">{t("검색")}</button>
            </form>
          </>
        ) : (
          <>
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
            <button
              type="button"
              className={styles.searchToggle}
              onClick={() => setSearchMode(true)}
              aria-label={t("전체 파일 검색")}
            >
              ⌕
            </button>
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
          </>
        )}
      </header>

      {notice && (
        <p
          className={notice.kind === "error" ? styles.error : styles.notice}
          role={notice.kind === "error" ? "alert" : "status"}
          onClick={() => setNotice(null)}
        >
          {notice.text}
          {notice.kind === "error" && (
            <span className={styles.noticeDismiss}>
              {t("(눌러서 닫기)")}
            </span>
          )}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <ul className={styles.list}>
        {searchState ? (
          searchState.status === "loading" ? (
            <li className={styles.empty} role="status">
              {t("찾는 중")}
            </li>
          ) : searchState.status === "error" ? (
            <li className={styles.empty}>{t("검색하지 못했어요")}</li>
          ) : searchState.results.length === 0 ? (
            <li className={styles.empty}>{t("검색 결과가 없습니다")}</li>
          ) : (
            <>
              {searchState.truncated && (
                <li className={styles.empty}>
                  {t("일부 결과만 표시했습니다")}
                </li>
              )}
              {searchState.results.map((hit) => (
                <li key={hit.entry.id} className={styles.resultItem}>
                  <button
                    type="button"
                    className={styles.row}
                    {...longPressProps(hit.entry)}
                    onClick={() => {
                      if (consumeLongPress()) return;
                      if (hit.entry.isFolder) {
                        goToCrumbs([
                          ...hit.breadcrumbs,
                          { id: hit.entry.id, name: hit.entry.name },
                        ]);
                      } else {
                        openEntry(hit.entry);
                      }
                    }}
                  >
                    <span className={styles.rowIcon} aria-hidden="true">
                      <PixelFileIcon entry={hit.entry} size={28} />
                    </span>
                    <span className={styles.rowText}>
                      <span className={styles.rowName}>{hit.entry.name}</span>
                      <span className={styles.rowMeta}>{hit.path}</span>
                    </span>
                  </button>
                  {/* 파일을 열지 않고 담긴 폴더로 가는 두 번째 손잡이. */}
                  <button
                    type="button"
                    className={styles.locButton}
                    aria-label={t("원래 위치 열기")}
                    onClick={() => goToCrumbs(hit.breadcrumbs)}
                  >
                    ▶
                  </button>
                </li>
              ))}
            </>
          )
        ) : loading ? (
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
                {...longPressProps(entry)}
                onClick={() => {
                  if (consumeLongPress()) return;
                  openEntry(entry);
                }}
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

      {sheet && (
        <div
          className={styles.sheetBackdrop}
          role="presentation"
          onClick={closeSheet}
        >
          <div
            className={styles.sheet}
            role="menu"
            aria-label={t("{name} 메뉴", { name: sheet.name })}
            onClick={(event) => event.stopPropagation()}
          >
            <strong className={styles.sheetTitle}>{sheet.name}</strong>
            {sheetInfo ? (
              <dl className={styles.sheetProps}>
                <dt>{t("올린 사람")}</dt>
                <dd>
                  {sheetInfo.uploadedBy ?? t("기록 없음")}
                  {sheetInfo.uploadedAt
                    ? ` · ${new Date(sheetInfo.uploadedAt).toLocaleString()}`
                    : ""}
                </dd>
                {!sheet.isFolder && (
                  <>
                    <dt>{t("크기")}</dt>
                    <dd>{formatSize(sheetInfo.size)}</dd>
                  </>
                )}
                <dt>{t("마지막 수정")}</dt>
                <dd>
                  {sheetInfo.modifiedAt
                    ? new Date(sheetInfo.modifiedAt).toLocaleString()
                    : "—"}
                </dd>
                {sheetInfo.downloadCount !== null && (
                  <>
                    <dt>{t("내려받기")}</dt>
                    <dd>{t("{count}번", { count: sheetInfo.downloadCount })}</dd>
                  </>
                )}
              </dl>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => sheetRename(sheet)}
                >
                  {t("이름 바꾸기")}
                </button>
                {trail.length > 0 && sheet.version && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => sheetMoveUp(sheet)}
                  >
                    {t("상위 폴더로 이동")}
                  </button>
                )}
                {!sheet.isFolder && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => sheetQuickLink(sheet)}
                  >
                    {t("1시간 빠른 공유")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => sheetProperties(sheet)}
                >
                  {t("속성")}
                </button>
                {sheet.isFolder && allowUpload && (
                  <div
                    className={styles.sheetSwatches}
                    role="group"
                    aria-label={t("폴더 색")}
                  >
                    <button
                      type="button"
                      className={styles.sheetSwatch}
                      data-color="default"
                      title={t("기본")}
                      aria-label={t("기본")}
                      disabled={busy}
                      onClick={() => sheetColor(sheet, null)}
                    />
                    {FOLDER_COLOR_IDS.map((colorId) => (
                      <button
                        key={colorId}
                        type="button"
                        className={styles.sheetSwatch}
                        data-color={colorId}
                        title={t(FOLDER_COLOR_LABELS[colorId])}
                        aria-label={t(FOLDER_COLOR_LABELS[colorId])}
                        disabled={busy}
                        onClick={() => sheetColor(sheet, colorId)}
                      />
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className={styles.sheetDanger}
                  disabled={busy}
                  onClick={() => sheetTrash(sheet)}
                >
                  {t("휴지통에 넣기")}
                </button>
              </>
            )}
            <button type="button" onClick={closeSheet}>
              {t("닫기")}
            </button>
          </div>
        </div>
      )}

      {progress && (
        <div className={styles.uploadProgress} role="status">
          <span className={styles.uploadProgressName}>
            {t("올리는 중 {current}/{total}", {
              current: progress.current,
              total: progress.total,
            })}
            {" · "}
            {progress.name}
          </span>
          <progress max={100} value={progress.percent} />
          <span className={styles.uploadPercent}>{progress.percent}%</span>
        </div>
      )}

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
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={busy}
          >
            <span aria-hidden="true">◉</span>
            {t("사진 찍기")}
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
          {/* capture는 폰에서 카메라를 바로 연다. 카메라가 없는 환경은
              브라우저가 알아서 파일 선택으로 폴백한다. 업로드는 위와 같은
              직행 경로(uploadFiles → uploadOne)라 크기 상한이 없다. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
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
