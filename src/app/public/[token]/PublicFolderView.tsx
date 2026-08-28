"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { translate, type Locale } from "@/lib/i18n";
import { formatSize } from "@/lib/client/mobile-listing";
import PixelFileIcon from "../../files/PixelFileIcon";
import desktopStyles from "../../files/desktop.module.css";
import mobileStyles from "../../files/mobile.module.css";
import {
  MOBILE_LAYOUT_MAX_WIDTH,
  logicalViewportFor,
  uiScaleForViewport,
} from "../../files/ui-scale";

// 공개 폴더 화면(#10). 화면은 데스크 바탕화면과 똑같이 — desktop.module.css·
// PixelFileIcon·ui-scale을 그대로 재사용해 픽셀 룩을 재현한다. FilesView는
// 세션·presence·채팅에 얽힌 멤버 전용 셸이라 재사용하지 않는다(별도 축소 뷰).
//
// 방문자가 할 수 있는 것: 목록 보기 · 다운로드 · 업로드. 하위 폴더 생성·
// 삭제·이름 변경·아이콘 드래그는 없다. 폴더 드롭은 거부한다(평평 유지).

interface PublicEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string | null;
}

interface Listing {
  name: string;
  entries: PublicEntry[];
  positions: Record<string, { x: number; y: number }>;
}

// FilesView와 같은 6열 기본 격자(좌표가 저장되지 않은 항목의 배치).
const DOWNLOAD_FIRST_KEY = "sharedesk-public-download-first";

// 저장값 구독 — 이 값은 이 탭에서만 바뀌므로(토글) 외부 구독은 필요 없고,
// 갱신은 revision 상태로 알린다. 서버 스냅숏은 항상 기본값(true)이다.
function subscribeNoop() {
  return () => {};
}

function readDownloadFirst(_revision: number): boolean {
  void _revision;
  try {
    return window.localStorage.getItem(DOWNLOAD_FIRST_KEY) !== "0";
  } catch {
    return true;
  }
}

const ICON_COLUMNS = 6;
const ICON_COLUMN_WIDTH = 96;
const ICON_ROW_HEIGHT = 104;
const ICON_INSET_X = 12;
const ICON_INSET_Y = 10;
const LIST_POLL_MS = 30_000;

function subscribeViewport(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

function viewportSnapshot() {
  return `${window.innerWidth}:${window.innerHeight}`;
}

function useViewport() {
  const snapshot = useSyncExternalStore(
    subscribeViewport,
    viewportSnapshot,
    () => "1280:720",
  );
  const [width, height] = snapshot.split(":").map(Number);
  return { width, height };
}

function defaultPlacement(index: number): { x: number; y: number } {
  const column = index % ICON_COLUMNS;
  const row = Math.floor(index / ICON_COLUMNS);
  return {
    x: ICON_INSET_X + column * ICON_COLUMN_WIDTH,
    y: ICON_INSET_Y + row * ICON_ROW_HEIGHT,
  };
}

// DataTransfer에 폴더가 섞였는지 — webkitGetAsEntry 기반(지원 안 되면 통과).
function hasDroppedDirectory(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items ?? [])) {
    const entry = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
      }
    ).webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
  }
  return false;
}

export default function PublicFolderView({
  token,
  name,
  isDeskUser,
  locale,
}: {
  token: string;
  name: string;
  isDeskUser: boolean;
  locale: Locale;
}) {
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  const viewport = useViewport();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 데스크와 같은 사용감(#14): 이름 검색과 다운로드 우선 토글.
  const [query, setQuery] = useState("");
  // 저장값은 마운트 뒤에 읽는다 — 초기 렌더에서 localStorage를 보면 서버
  // HTML(항상 기본값)과 어긋나 hydration 오류가 난다. useSyncExternalStore로
  // 읽으면 서버 스냅숏(true)과 클라 스냅숏이 분리돼 effect에서 setState 하지
  // 않고도 첫 페인트 뒤 저장값이 반영된다.
  const [storedRevision, setStoredRevision] = useState(0);
  const downloadFirst = useSyncExternalStore(
    subscribeNoop,
    // storedRevision이 바뀌면 다시 읽는다(토글 저장 직후 반영).
    useCallback(() => readDownloadFirst(storedRevision), [storedRevision]),
    () => true,
  );
  const selectDownloadFirst = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(DOWNLOAD_FIRST_KEY, next ? "1" : "0");
    } catch {
      // 저장 실패는 무시 — 이번 방문 동안만 유지된다.
    }
    setStoredRevision((revision) => revision + 1);
  }, []);
  const [uploading, setUploading] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 데스크와 같은 사용감(#14): 한 번 눌러 고르고, 두 번 눌러 열고,
  // 오른쪽 눌러 메뉴. 방문자라고 클릭이 아무 반응 없으면 안 된다.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: PublicEntry;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // 메뉴는 바깥을 누르거나 Esc로 닫는다(데스크와 같은 규칙). 메뉴 안을
  // 누른 것까지 닫아 버리면 pointerdown이 click보다 먼저라 항목이 눌리지
  // 않는다 — 담긴 곳을 확인하고 닫는다.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  useEffect(() => {
    // 늦게 도착한 옛 응답이 새 상태를 덮지 않게 한다(모바일 뷰와 같은 패턴).
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(`/api/public-folder/${token}`, {
          cache: "no-store",
        });
        if (!alive) return;
        if (response.status === 404) {
          setClosed(true);
          return;
        }
        const body = (await response
          .json()
          .catch(() => null)) as Listing | null;
        if (!alive) return;
        if (!response.ok || !body || !Array.isArray(body.entries)) {
          setError(t("목록을 불러오지 못했습니다"));
          return;
        }
        setError(null);
        setListing(body);
        // 폴링이 다시 200을 받으면(관리자가 기간 연장·재개) 닫힘 화면을
        // 푼다 — 새로고침 없이 복구된다.
        setClosed(false);
      } catch {
        if (alive) setError(t("목록을 불러오지 못했습니다"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, reloadKey, t]);

  useEffect(() => {
    const timer = window.setInterval(reload, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  // 브라우저에서 열어 보기 — 서버가 안전한 형식만 inline으로 준다
  // (나머지는 그대로 저장 창으로 떨어진다).
  const openInBrowser = useCallback(
    (entry: PublicEntry) => {
      window.open(
        `/api/public-folder/${token}/download?id=${encodeURIComponent(entry.id)}&open=1`,
        "_blank",
        "noopener,noreferrer",
      );
    },
    [token],
  );

  const saveToDisk = useCallback(
    (entry: PublicEntry) => {
      const anchor = document.createElement("a");
      anchor.href = `/api/public-folder/${token}/download?id=${encodeURIComponent(entry.id)}`;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
    [token],
  );

  // 두 번 눌렀을 때의 기본 동작. "다운로드 우선"이 켜져 있으면 내려받고,
  // 꺼져 있으면 열어 본다 — 데스크의 같은 토글과 뜻이 같다.
  const activate = useCallback(
    (entry: PublicEntry) => {
      if (downloadFirst) saveToDisk(entry);
      else openInBrowser(entry);
    },
    [downloadFirst, openInBrowser, saveToDisk],
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || uploading) return;
      setNotice(null);
      setUploading({ current: 0, total: files.length });
      let failed: string | null = null;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setUploading({ current: index + 1, total: files.length });
        try {
          const response = await fetch(
            `/api/public-folder/${token}/upload?name=${encodeURIComponent(file.name)}`,
            {
              method: "POST",
              cache: "no-store",
              headers: {
                "Content-Type": file.type || "application/octet-stream",
              },
              body: file,
            },
          );
          if (response.status === 404) {
            // 업로드 도중 폴더가 닫혔다 — 성공 알림 경로를 타지 않고 닫힘
            // 화면으로 전환한다(재개 후 거짓 "올렸습니다"가 남지 않게).
            setClosed(true);
            setUploading(null);
            return;
          }
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: unknown;
            } | null;
            failed =
              typeof body?.error === "string"
                ? t("{name}: {reason}", { name: file.name, reason: t(body.error) })
                : t("{name}을(를) 올리지 못했습니다", { name: file.name });
            break;
          }
        } catch {
          failed = t("{name}을(를) 올리지 못했습니다", { name: file.name });
          break;
        }
      }
      setUploading(null);
      if (failed) setNotice(failed);
      else setNotice(t("올렸습니다"));
      reload();
    },
    [token, uploading, reload, t],
  );

  // 정상 상태에서 공개 폴더는 평평하다 — 혹시 남은 폴더 항목은 렌더에서
  // 제외한다(방문자는 들어갈 수 없다).
  const files = useMemo(
    () => (listing?.entries ?? []).filter((entry) => !entry.isFolder),
    [listing],
  );

  // 검색은 표시만 거른다 — 배치(placements)는 전체 기준이라 검색을 지워도
  // 아이콘이 제자리로 돌아온다.
  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [files, query]);

  // 아이콘 배치. 저장 좌표(멤버가 데스크에서 놓은 위치)와 기본 격자가 같은
  // 상수라, 좌표 없는 새 파일을 index 격자에 그대로 두면 저장 좌표와 겹쳐
  // 아이콘이 파묻힌다 — 저장 좌표가 점유한 칸을 건너뛰며 빈 칸부터 채운다.
  const placements = useMemo(() => {
    const positions = listing?.positions ?? {};
    const keyOf = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const occupied = new Set<string>();
    for (const entry of files) {
      const saved = positions[entry.id];
      if (saved) occupied.add(keyOf(saved));
    }
    const result: Record<string, { x: number; y: number }> = {};
    let slot = 0;
    for (const entry of files) {
      const saved = positions[entry.id];
      if (saved) {
        result[entry.id] = saved;
        continue;
      }
      let placement = defaultPlacement(slot);
      while (occupied.has(keyOf(placement))) {
        slot += 1;
        placement = defaultPlacement(slot);
      }
      occupied.add(keyOf(placement));
      result[entry.id] = placement;
      slot += 1;
    }
    return result;
  }, [files, listing]);

  if (closed) {
    return (
      <main className={desktopStyles.viewport}>
        <div
          className={desktopStyles.desktop}
          style={{ width: "100%", height: "100%" }}
        >
          <div className={desktopStyles.wallpaper} aria-hidden="true" />
          <div className={desktopStyles.canvasMessage} role="status">
            <strong>{t("이 공개 폴더는 닫혀 있습니다")}</strong>
          </div>
        </div>
      </main>
    );
  }

  // 좁은 화면은 데스크와 같은 규칙으로 세로 목록을 쓴다.
  if (viewport.width > 0 && viewport.width < MOBILE_LAYOUT_MAX_WIDTH) {
    return (
      <main className={mobileStyles.screen}>
        <header className={mobileStyles.bar}>
          <span className={mobileStyles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <strong className={mobileStyles.title}>
            {t("공개폴더: {name}", { name: listing?.name ?? name })}
          </strong>
          {isDeskUser && (
            <a href="/files" className={mobileStyles.backButton}>
              {t("나가기")}
            </a>
          )}
        </header>
        {notice && (
          <p className={mobileStyles.notice} role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className={mobileStyles.error} role="alert">
            {error}
          </p>
        )}
        <ul className={mobileStyles.list}>
          {files.length === 0 && !error && (
            <li className={mobileStyles.empty}>{t("아직 파일이 없습니다")}</li>
          )}
          {files.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={mobileStyles.row}
                onClick={() => activate(entry)}
              >
                <span className={mobileStyles.rowIcon} aria-hidden="true">
                  <PixelFileIcon entry={entry} size={34} />
                </span>
                <span className={mobileStyles.rowText}>
                  <span className={mobileStyles.rowName}>{entry.name}</span>
                  <span className={mobileStyles.rowMeta}>
                    {formatSize(entry.size)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <footer className={mobileStyles.dock}>
          <button
            type="button"
            disabled={uploading !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading
              ? t("올리는 중 {current}/{total}", uploading)
              : t("올리기")}
          </button>
        </footer>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = "";
            void uploadFiles(selected);
          }}
        />
      </main>
    );
  }

  const uiScale = uiScaleForViewport(viewport.width, viewport.height);
  const logicalViewport = logicalViewportFor(
    viewport.width,
    viewport.height,
    uiScale,
  );

  return (
    <main
      className={desktopStyles.viewport}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className={desktopStyles.desktop}
        style={{
          width: logicalViewport.width,
          height: logicalViewport.height,
          transform: `scale(${uiScale})`,
        }}
      >
        <div className={desktopStyles.wallpaper} aria-hidden="true" />
        <header className={desktopStyles.topBar}>
          <div className={desktopStyles.brand}>
            <span className={desktopStyles.brandMark} aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            <strong>ShareDesk</strong>
            <span className={desktopStyles.desktopLabel}>
              {t("공개폴더: {name}", { name: listing?.name ?? name })}
            </span>
          </div>
        </header>

        <div
          className={`${desktopStyles.iconCanvas} ${desktopStyles.rootCanvas}`}
          role="region"
          aria-label={t("공개폴더: {name}", { name: listing?.name ?? name })}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(event) => {
            if (event.target === event.currentTarget) setDragOver(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            if (uploading) return;
            if (hasDroppedDirectory(event.dataTransfer)) {
              setNotice(t("폴더는 올릴 수 없습니다 — 파일만 올려 주세요"));
              return;
            }
            void uploadFiles(Array.from(event.dataTransfer.files ?? []));
          }}
          onPointerDown={(event) => {
            // 빈 바탕을 누르면 고른 것을 놓는다 — 데스크와 같다.
            if (event.target === event.currentTarget) setSelectedId(null);
          }}
        >
          <div className={desktopStyles.iconPlane}>
            {visibleFiles.map((entry) => {
              const placement = placements[entry.id];
              const selected = selectedId === entry.id;
              return (
                <div
                  key={entry.id}
                  className={`${desktopStyles.desktopIcon} ${
                    selected ? desktopStyles.iconSelected : ""
                  }`}
                  style={{ left: placement.x, top: placement.y }}
                >
                  <button
                    type="button"
                    className={desktopStyles.iconMain}
                    aria-pressed={selected}
                    title={
                      downloadFirst
                        ? t("두 번 눌러 내려받기")
                        : t("두 번 눌러 열기")
                    }
                    onClick={() => setSelectedId(entry.id)}
                    onDoubleClick={() => activate(entry)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedId(entry.id);
                      if (event.key === "Enter") activate(entry);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedId(entry.id);
                      setMenu({
                        x: event.clientX / uiScale,
                        y: event.clientY / uiScale,
                        entry,
                      });
                    }}
                  >
                    <PixelFileIcon entry={entry} size={54} />
                    <span className={desktopStyles.iconName}>{entry.name}</span>
                  </button>
                </div>
              );
            })}
            {error && (
              <div className={desktopStyles.canvasMessage} role="alert">
                <strong>{error}</strong>
                <button type="button" onClick={reload}>
                  {t("다시 시도")}
                </button>
              </div>
            )}
          </div>
          {dragOver && (
            <div className={desktopStyles.dropOverlay} aria-hidden="true">
              {t("여기에 놓아 주세요")}
            </div>
          )}
        </div>

        <footer className={desktopStyles.taskBar}>
          {/* 올리기는 끌어다 놓기(#14) — 버튼 없이 데스크와 같은 문법. */}
          <div className={desktopStyles.desktopSearch} role="search">
            <input
              type="search"
              value={query}
              placeholder={t("파일 검색")}
              aria-label={t("파일 검색")}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <label className={desktopStyles.downloadPreference}>
            <input
              type="checkbox"
              checked={downloadFirst}
              onChange={(event) => selectDownloadFirst(event.target.checked)}
            />
            <span className={desktopStyles.preferenceCheck} aria-hidden="true" />
            <span>{t("다운로드 우선")}</span>
          </label>
          {uploading && (
            <span role="status" className={desktopStyles.desktopLabel}>
              {t("올리는 중 {current}/{total}", uploading)}
            </span>
          )}
          {notice && (
            <span role="status" className={desktopStyles.desktopLabel}>
              {notice}
            </span>
          )}
          <div className={desktopStyles.userTray}>
            {isDeskUser && (
              <a href="/files" className={desktopStyles.trayLink}>
                {t("나가기")}
              </a>
            )}
          </div>
        </footer>

        {/* 오른쪽 눌러 나오는 메뉴(#14). 방문자에게도 열기·내려받기를
            같은 자리에서 준다 — 두 번 누르는 법을 몰라도 되게. */}
        {menu && (
          <div
            ref={menuRef}
            className={desktopStyles.contextMenu}
            style={{ left: menu.x, top: menu.y }}
            role="menu"
            aria-label={t("{name} 메뉴", { name: menu.entry.name })}
          >
            <button
              type="button"
              role="menuitem"
              className={desktopStyles.menuItem}
              onClick={() => {
                openInBrowser(menu.entry);
                setMenu(null);
              }}
            >
              {t("열기")}
            </button>
            <button
              type="button"
              role="menuitem"
              className={desktopStyles.menuItem}
              onClick={() => {
                saveToDisk(menu.entry);
                setMenu(null);
              }}
            >
              {t("내려받기")}
            </button>
          </div>
        )}
        {/* 데스크톱은 끌어다 놓기로만 올린다(#14 9) — 파일 선택창은 모바일
            dock 전용이라 그 분기에만 둔다. */}
      </div>
    </main>
  );
}
