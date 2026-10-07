"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { translate, type Locale } from "@/lib/i18n";
import type { SelectionRect } from "@/lib/client/batch-selection";
import { formatSize } from "@/lib/client/mobile-listing";
import {
  formatVisitorDownloadStatus,
  useVisitorDownloads,
} from "@/lib/client/visitor-downloads";
import {
  EMPTY_VISITOR_SELECTION,
  clickVisitorSelection,
  isVisitorSelected,
  pruneVisitorSelection,
  rectangleVisitorSelection,
  selectedVisitorFiles,
  type VisitorSelection,
} from "@/lib/client/visitor-selection";
import { GUEST_NAME_HEADER, MAX_GUEST_NAME_LENGTH } from "@/lib/nickname";
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
// 방문자가 할 수 있는 것: 목록 보기 · 다운로드 · 업로드 · 여러 파일 골라 한꺼번에
// 받기(#17 B-6). 하위 폴더 생성·삭제·이름 변경·아이콘 드래그는 없다. 폴더
// 드롭은 거부한다(평평 유지).

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

// 목록 응답의 안내문(#17 B-5). 관리자가 켠 폴더만 noteHash가 오고, 본문(note)은
// 화면이 아는 해시(?noteHash=)와 다를 때만 온다 — 30초 폴링마다 메모 전체를
// 다시 받지 않게. 꺼져 있으면 둘 다 없다.
interface ListingNote {
  noteHash?: unknown;
  note?: unknown;
}

// 안내문 띠(#17 B-5). 처음엔 6줄까지만 보이고, 넘치면 "더 보기/접기".
// 마크다운 해석 없이 글자 그대로, 줄바꿈만 살린다(CSS pre-wrap).
type Translate = (text: string, vars?: Record<string, string | number>) => string;

function PublicNoteBand({
  note,
  className,
  t,
}: {
  note: string;
  className: string;
  t: Translate;
}) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  // 잘렸는지는 그려진 크기로만 안다 — 크기가 바뀔 때마다(글·폭·펼침) 다시 잰다.
  useEffect(() => {
    const element = textRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.dataset.collapsed !== "true") return;
      setClipped(element.scrollHeight > element.clientHeight + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [note]);
  return (
    <section className={className} aria-label={t("안내문")}>
      <strong>
        <span className={desktopStyles.folderNoteGlyph} aria-hidden="true" />
        {t("안내문")}
      </strong>
      <p ref={textRef} data-collapsed={expanded ? "false" : "true"}>
        {note}
      </p>
      {(clipped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("접기") : t("더 보기")}
        </button>
      )}
    </section>
  );
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

// 보내는 사람 이름(#17 B-4) — 선택 입력. 이 브라우저에, 공개 폴더(토큰)마다
// 따로 기억해 다음 업로드에 미리 채운다(서버는 업로드 기록에만 쓰고 따로
// 보관하지 않는다).
function senderNameKey(token: string): string {
  return `sharedesk-public-sender-name:${token}`;
}

const ICON_COLUMNS = 6;
const ICON_COLUMN_WIDTH = 96;
const ICON_ROW_HEIGHT = 104;
const ICON_INSET_X = 12;
const ICON_INSET_Y = 10;
const LIST_POLL_MS = 30_000;
// 아이콘 한 칸의 크기(desktop.module.css .desktopIcon) — 고무줄 선택의 판정 상자.
const ICON_WIDTH = 88;
const ICON_HEIGHT = 94;

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
  initialNote,
  initialNoteHash,
  isDeskUser,
  isAdmin,
  locale,
}: {
  token: string;
  name: string;
  // 첫 화면의 안내문과 그 해시(서버가 같은 판정으로 읽은 값). 이후 폴링은
  // 해시만 맞춰 보고, 바뀌면 새 글을, 꺼지면 사라진다.
  initialNote: string | null;
  initialNoteHash: string | null;
  isDeskUser: boolean;
  // 관리자만 아이콘을 끌어 배치를 바꾼다(방문자가 보는 위치가 된다).
  isAdmin: boolean;
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
  // 보내는 사람: 저장값은 마운트 뒤에 한 번 읽는다(서버 HTML은 늘 빈 칸이라
  // 첫 렌더에서 읽으면 hydration이 어긋난다). effect 본문에서 바로 setState하면
  // 연쇄 렌더 규칙(react-hooks/set-state-in-effect)에 걸려, 생성된 링크 창처럼
  // 0ms 타이머 콜백에서 읽는다. 그 사이 입력한 값이 있으면 덮지 않는다. 저장이
  // 막힌 브라우저에서도 입력은 이 상태로 동작한다.
  const [sender, setSender] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(senderNameKey(token));
        if (stored) {
          setSender((current) => current || stored.slice(0, MAX_GUEST_NAME_LENGTH));
        }
      } catch {
        // 읽기 실패는 무시 — 빈 칸에서 시작한다.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [token]);
  const changeSender = useCallback(
    (next: string) => {
      setSender(next);
      try {
        if (next.trim()) window.localStorage.setItem(senderNameKey(token), next);
        else window.localStorage.removeItem(senderNameKey(token));
      } catch {
        // 저장 실패는 무시 — 이번 방문 동안만 유지된다.
      }
    },
    [token],
  );
  const [uploading, setUploading] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 데스크와 같은 사용감(#14): 한 번 눌러 고르고, 두 번 눌러 열고,
  // 오른쪽 눌러 메뉴. 방문자라고 클릭이 아무 반응 없으면 안 된다.
  // 여러 개 고르기(#17 B-6)는 데스크 규칙 그대로 — Ctrl/⌘ 넣고 빼기, Shift 범위,
  // 빈 바탕에서 끌어 고무줄.
  const [selection, setSelection] = useState<VisitorSelection>(
    EMPTY_VISITOR_SELECTION,
  );
  const [marquee, setMarquee] = useState<SelectionRect | null>(null);
  // 좁은 화면은 Ctrl·고무줄이 없으니 "고르기"를 켜고 줄을 눌러 고른다.
  const [selectMode, setSelectMode] = useState(false);
  // 고른 파일 받기 — 서버 zip 없이 3개씩 차례로(받기 화면의 모두 받기와 같은 큐).
  const downloads = useVisitorDownloads(
    (entryId) =>
      `/api/public-folder/${token}/download?id=${encodeURIComponent(entryId)}`,
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: PublicEntry;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 관리자 끌어놓기 진행 상태. ref는 포인터 이벤트 사이의 시작점·원위치,
  // state는 끌리는 동안 그릴 논리 좌표(uiScale 반영)다.
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  // 안내문: 글과 해시를 함께 들고, 폴링에는 아는 해시를 실어 보낸다.
  const [note, setNote] = useState<string | null>(initialNote);
  const noteHashRef = useRef<string | null>(initialNoteHash);

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
        const knownHash = noteHashRef.current;
        const response = await fetch(
          `/api/public-folder/${token}${
            knownHash ? `?noteHash=${encodeURIComponent(knownHash)}` : ""
          }`,
          { cache: "no-store" },
        );
        if (!alive) return;
        if (response.status === 404) {
          setClosed(true);
          return;
        }
        const body = (await response
          .json()
          .catch(() => null)) as (Listing & ListingNote) | null;
        if (!alive) return;
        if (!response.ok || !body || !Array.isArray(body.entries)) {
          setError(t("목록을 불러오지 못했습니다"));
          return;
        }
        setError(null);
        setListing(body);
        // 파일이 하나도 없으면 좁은 화면의 고르기 모드를 끈다 — 고를 것도, 고르기
        // 단추도 없는데 독이 "선택 0개 받기"에 갇히지 않게(올리기로 돌아온다).
        if (!body.entries.some((entry) => !entry.isFolder)) {
          setSelectMode(false);
          setSelection(EMPTY_VISITOR_SELECTION);
        }
        if (typeof body.noteHash !== "string") {
          noteHashRef.current = null;
          setNote(null);
        } else if (typeof body.note === "string") {
          noteHashRef.current = body.noteHash;
          setNote(body.note);
        }
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
      // 이름은 URL이 아니라 헤더로(접근 로그에 남지 않게), 헤더는 ASCII만 되므로
      // percent-encoding. 서버가 다시 정제·검증한다(보이지 않는 문자 제거, 40자).
      const senderName = sender.trim();
      const senderHeader: Record<string, string> = senderName
        ? { [GUEST_NAME_HEADER]: encodeURIComponent(senderName) }
        : {};
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
                ...senderHeader,
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
    [token, uploading, reload, sender, t],
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

  // 화면 순서(위→아래, 왼쪽→오른쪽 격자) — Shift 범위와 받는 순서의 기준.
  const orderedFiles = useMemo(
    () =>
      [...visibleFiles].sort((left, right) => {
        const a = placements[left.id];
        const b = placements[right.id];
        return a.y - b.y || a.x - b.x;
      }),
    [visibleFiles, placements],
  );
  // 좁은 화면은 데스크와 같은 규칙으로 세로 목록을 쓴다(검색 칸은 데스크톱 전용).
  const narrow = viewport.width > 0 && viewport.width < MOBILE_LAYOUT_MAX_WIDTH;
  // 목록이 바뀌면(30초 폴링·검색) 사라지거나 가려진 항목은 선택에서 빠진다 —
  // 상태를 고쳐 쓰지 않고 그릴 때 거른다. 좁은 화면에는 검색이 없으니 전체
  // 파일(files)이 기준이다(넓은 화면에서 남긴 검색어에 가려지지 않게).
  const liveSelection = useMemo(
    () =>
      pruneVisitorSelection(
        selection,
        (narrow ? files : visibleFiles).map((entry) => entry.id),
      ),
    [selection, narrow, files, visibleFiles],
  );
  const selectFromClick = useCallback(
    (
      id: string,
      event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    ) => {
      setSelection(
        clickVisitorSelection(
          liveSelection,
          id,
          orderedFiles.map((entry) => entry.id),
          { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey },
        ),
      );
    },
    [liveSelection, orderedFiles],
  );
  // 받을 파일 — 고른 것 중 파일만, 화면 순서대로.
  const selectedFiles = selectedVisitorFiles(orderedFiles, liveSelection);
  // 받기 진행 표시 — 받기 화면(#17 B-3)의 모두 받기와 같은 문구.
  const downloadSummary = downloads.summary;
  const downloadStatus = formatVisitorDownloadStatus(downloadSummary, t);

  // 관리자 끌어놓기(요청: 관리자는 공유폴더에서 파일 위치를 바꾼다). 데스크
  // 폴더 창과 같은 격자에 스냅하고, 이미 차 있는 칸이면 가장 가까운 빈 칸으로
  // 보낸다 — 아이콘이 겹쳐 파묻히는 일이 없게.
  const nearestFreeCell = useCallback(
    (x: number, y: number, movingId: string) => {
      const occupied = new Set<string>();
      for (const entry of files) {
        if (entry.id === movingId) continue;
        const placed = placements[entry.id];
        if (placed) occupied.add(`${placed.x},${placed.y}`);
      }
      const column = Math.max(
        0,
        Math.round((x - ICON_INSET_X) / ICON_COLUMN_WIDTH),
      );
      const row = Math.max(0, Math.round((y - ICON_INSET_Y) / ICON_ROW_HEIGHT));
      for (let ring = 0; ring <= 8; ring += 1) {
        let best: { x: number; y: number } | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let dc = -ring; dc <= ring; dc += 1) {
          for (let dr = -ring; dr <= ring; dr += 1) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
            const c = column + dc;
            const r = row + dr;
            if (c < 0 || r < 0) continue;
            const cell = {
              x: ICON_INSET_X + c * ICON_COLUMN_WIDTH,
              y: ICON_INSET_Y + r * ICON_ROW_HEIGHT,
            };
            if (occupied.has(`${cell.x},${cell.y}`)) continue;
            const distance = Math.hypot(cell.x - x, cell.y - y);
            if (distance < bestDistance) {
              best = cell;
              bestDistance = distance;
            }
          }
        }
        if (best) return best;
      }
      return null;
    },
    [files, placements],
  );

  // 저장은 낙관적으로 먼저 그리고, 실패하면 원위치로 되돌린다. 서버는
  // entry id → layoutKey 변환과 버전을 채워 데스크 폴더 배치에 쓴다.
  const placeIcon = useCallback(
    async (entry: PublicEntry, target: { x: number; y: number }) => {
      const previous = listing?.positions[entry.id];
      setListing((current) =>
        current
          ? {
              ...current,
              positions: { ...current.positions, [entry.id]: target },
            }
          : current,
      );
      try {
        const response = await fetch(`/api/public-folder/${token}/layout`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: entry.id, x: target.x, y: target.y }),
        });
        const body = (await response.json().catch(() => null)) as {
          positions?: Listing["positions"];
        } | null;
        if (!response.ok || !body?.positions) throw new Error("layout");
        const saved = body.positions;
        setListing((current) =>
          current ? { ...current, positions: saved } : current,
        );
      } catch {
        setListing((current) => {
          if (!current) return current;
          const positions = { ...current.positions };
          if (previous) positions[entry.id] = previous;
          else delete positions[entry.id];
          return { ...current, positions };
        });
        setNotice(t("위치를 저장하지 못했습니다"));
      }
    },
    [listing, token, t],
  );

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

  if (narrow) {
    // 목록 순서대로 받는다.
    const mobileSelected = selectedVisitorFiles(files, liveSelection);
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
          {/* 좁은 화면의 여러 개 고르기(#17 B-6) — 켜면 줄을 눌러 고르고, 끄면 놓는다. */}
          {files.length > 0 && (
            <button
              type="button"
              className={`${mobileStyles.backButton} ${mobileStyles.publicSelectToggle}`}
              aria-pressed={selectMode}
              onClick={() => {
                setSelectMode((current) => !current);
                setSelection(EMPTY_VISITOR_SELECTION);
              }}
            >
              {selectMode ? t("취소") : t("고르기")}
            </button>
          )}
          {isDeskUser && (
            <a href="/files" className={mobileStyles.backButton}>
              {t("나가기")}
            </a>
          )}
        </header>
        {note && (
          <PublicNoteBand note={note} className={mobileStyles.publicNote} t={t} />
        )}
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
        {downloadStatus && (
          <p className={mobileStyles.notice} role="status">
            {downloadStatus}
          </p>
        )}
        <ul className={mobileStyles.list}>
          {files.length === 0 && !error && (
            <li className={mobileStyles.empty}>{t("아직 파일이 없습니다")}</li>
          )}
          {files.map((entry) => {
            const picked = selectMode && isVisitorSelected(liveSelection, entry.id);
            return (
            <li key={entry.id}>
              <button
                type="button"
                className={`${mobileStyles.row} ${picked ? mobileStyles.rowPicked : ""}`}
                aria-pressed={selectMode ? picked : undefined}
                onClick={() => {
                  if (!selectMode) {
                    activate(entry);
                    return;
                  }
                  setSelection(
                    clickVisitorSelection(
                      liveSelection,
                      entry.id,
                      files.map((file) => file.id),
                      { toggle: true, range: false },
                    ),
                  );
                }}
              >
                {selectMode && (
                  <span
                    className={mobileStyles.rowCheck}
                    data-checked={picked ? "true" : "false"}
                    aria-hidden="true"
                  />
                )}
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
            );
          })}
        </ul>
        <footer className={mobileStyles.dock}>
          {selectMode ? (
            <button
              type="button"
              disabled={mobileSelected.length === 0 || downloadSummary.active > 0}
              onClick={() => downloads.enqueue(mobileSelected)}
            >
              {t("선택 {count}개 받기", { count: mobileSelected.length })}
            </button>
          ) : (
            <>
              <input
                className={mobileStyles.senderInput}
                value={sender}
                maxLength={MAX_GUEST_NAME_LENGTH}
                placeholder={t("보내는 사람 (선택)")}
                aria-label={t("보내는 사람 (선택)")}
                autoComplete="name"
                onChange={(event) => changeSender(event.target.value)}
              />
              <button
                type="button"
                disabled={uploading !== null}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading
                  ? t("올리는 중 {current}/{total}", uploading)
                  : t("올리기")}
              </button>
            </>
          )}
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

  // 빈 바탕을 누르면 고른 것을 놓고(Ctrl/⌘면 그대로), 마우스로 끌면 고무줄로
  // 고른다 — 데스크와 같다. 좌표는 아이콘 판 기준 논리 좌표(uiScale로 나눈 값)라
  // 아이콘 배치(placements)와 바로 견준다.
  const startMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-public-entry]")) return;
    const additive = event.ctrlKey || event.metaKey;
    if (!additive) setSelection(EMPTY_VISITOR_SELECTION);
    if (event.pointerType !== "mouse") return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerId = event.pointerId;
    const startX = (event.clientX - bounds.left) / uiScale;
    const startY = (event.clientY - bounds.top) / uiScale;
    const initial = liveSelection;
    const candidates = visibleFiles.map((entry) => ({
      layoutKey: entry.id,
      x: placements[entry.id].x,
      y: placements[entry.id].y,
      width: ICON_WIDTH,
      height: ICON_HEIGHT,
    }));
    let moved = false;
    const onMove = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const currentX = (next.clientX - bounds.left) / uiScale;
      const currentY = (next.clientY - bounds.top) / uiScale;
      if (!moved && Math.hypot(currentX - startX, currentY - startY) < 3) return;
      moved = true;
      const rectangle = {
        x: Math.min(startX, currentX),
        y: Math.min(startY, currentY),
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY),
      };
      setMarquee(rectangle);
      setSelection(
        rectangleVisitorSelection(initial, candidates, rectangle, additive),
      );
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      setMarquee(null);
    };
    const onEnd = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      cleanup();
    };
    const onCancel = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      cleanup();
      setSelection(initial);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onCancel);
  };

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

        {/* 머리줄과 작업표시줄 사이(#17 B-5). 안내문은 아이콘 판 위의 띠로 흐름 안에
            두어, 띠 높이만큼 판이 내려간다 — 아이콘을 가리지 않는다. */}
        <div className={desktopStyles.publicStage}>
          {note && (
            <PublicNoteBand note={note} className={desktopStyles.publicNote} t={t} />
          )}
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
          >
            {/* 판이 캔버스를 다 덮으므로 빈 바탕 누르기·고무줄은 판에서 받는다. */}
            <div className={desktopStyles.iconPlane} onPointerDown={startMarquee}>
              {visibleFiles.map((entry) => {
                const placement = placements[entry.id];
                const selected = isVisitorSelected(liveSelection, entry.id);
                const dragging = drag?.id === entry.id;
                return (
                  <div
                    key={entry.id}
                    data-public-entry=""
                    className={`${desktopStyles.desktopIcon} ${
                      selected ? desktopStyles.iconSelected : ""
                    }`}
                    style={{
                      left: dragging ? drag.x : placement.x,
                      top: dragging ? drag.y : placement.y,
                      ...(isAdmin
                        ? {
                            touchAction: "none" as const,
                            cursor: dragging ? "grabbing" : "grab",
                          }
                        : {}),
                      ...(dragging ? { zIndex: 5 } : {}),
                    }}
                    // 관리자만 끌어 배치를 바꾼다 — 방문자에게는 핸들러 자체가
                    // 붙지 않는다. 4px 넘게 움직여야 끌기로 본다(클릭과 구분).
                    onPointerDown={
                      isAdmin
                        ? (event) => {
                            if (event.button !== 0) return;
                            // Ctrl/⌘·Shift 누름은 고르기다 — 끌기를 시작하지 않고
                            // 아래 클릭(selectFromClick)에 맡긴다.
                            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                              return;
                            }
                            // 이미 고른 묶음 안의 아이콘이면 묶음을 깨지 않는다.
                            if (!isVisitorSelected(liveSelection, entry.id)) {
                              setSelection({ ids: [entry.id], anchorId: entry.id });
                            }
                            dragRef.current = {
                              id: entry.id,
                              startX: event.clientX,
                              startY: event.clientY,
                              originX: placement.x,
                              originY: placement.y,
                              moved: false,
                            };
                            try {
                              event.currentTarget.setPointerCapture(event.pointerId);
                            } catch {
                              // 이미 놓인 포인터(합성 이벤트 등)면 캡처 없이 진행한다.
                            }
                          }
                        : undefined
                    }
                    onPointerMove={
                      isAdmin
                        ? (event) => {
                            const current = dragRef.current;
                            if (!current || current.id !== entry.id) return;
                            const dx = (event.clientX - current.startX) / uiScale;
                            const dy = (event.clientY - current.startY) / uiScale;
                            if (!current.moved && Math.hypot(dx, dy) < 4) return;
                            current.moved = true;
                            setDrag({
                              id: entry.id,
                              x: Math.max(0, current.originX + dx),
                              y: Math.max(0, current.originY + dy),
                            });
                          }
                        : undefined
                    }
                    onPointerUp={
                      isAdmin
                        ? (event) => {
                            const current = dragRef.current;
                            dragRef.current = null;
                            setDrag(null);
                            if (!current || current.id !== entry.id) return;
                            if (!current.moved) {
                              // 끌지 않고 뗀 그냥 누름 — 그것 하나만 고른다(데스크와
                              // 같다). 포인터를 잡은 동안의 click은 버튼까지 오지
                              // 않을 수 있어 여기서 정한다.
                              setSelection({ ids: [entry.id], anchorId: entry.id });
                              return;
                            }
                            const target = nearestFreeCell(
                              current.originX +
                                (event.clientX - current.startX) / uiScale,
                              current.originY +
                                (event.clientY - current.startY) / uiScale,
                              entry.id,
                            );
                            if (
                              !target ||
                              (target.x === current.originX &&
                                target.y === current.originY)
                            ) {
                              return;
                            }
                            void placeIcon(entry, target);
                          }
                        : undefined
                    }
                    onPointerCancel={
                      isAdmin
                        ? () => {
                            dragRef.current = null;
                            setDrag(null);
                          }
                        : undefined
                    }
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
                      onClick={(event) => selectFromClick(entry.id, event)}
                      onDoubleClick={() => activate(entry)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        selectFromClick(entry.id, event);
                        if (event.key === "Enter") activate(entry);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        // 고른 묶음 안에서 연 메뉴는 묶음을 그대로 둔다.
                        if (!isVisitorSelected(liveSelection, entry.id)) {
                          setSelection({ ids: [entry.id], anchorId: entry.id });
                        }
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
              {marquee && (
                <div
                  className={desktopStyles.selectionRectangle}
                  style={{
                    left: marquee.x,
                    top: marquee.y,
                    width: marquee.width,
                    height: marquee.height,
                  }}
                  aria-hidden="true"
                />
              )}
            </div>
            {dragOver && (
              <div className={desktopStyles.dropOverlay} aria-hidden="true">
                {t("여기에 놓아 주세요")}
              </div>
            )}
          </div>
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
          {/* 고른 파일 한꺼번에 받기(#17 B-6) — 서버 zip 없이 3개씩 차례로. */}
          {selectedFiles.length > 0 && (
            <button
              type="button"
              className={desktopStyles.publicBatchDownload}
              disabled={downloadSummary.active > 0}
              onClick={() => downloads.enqueue(selectedFiles)}
            >
              {t("선택 {count}개 받기", { count: selectedFiles.length })}
            </button>
          )}
          {downloadStatus && (
            <span role="status" className={desktopStyles.desktopLabel}>
              {downloadStatus}
            </span>
          )}
          {/* 올릴 때 함께 남는 이름(#17 B-4) — 비워 두면 "손님"으로만 남는다. */}
          <label className={desktopStyles.publicSender}>
            <span>{t("보내는 사람")}</span>
            <input
              value={sender}
              maxLength={MAX_GUEST_NAME_LENGTH}
              placeholder={t("이름 (선택)")}
              aria-label={t("보내는 사람 (선택)")}
              autoComplete="name"
              spellCheck={false}
              onChange={(event) => changeSender(event.target.value)}
            />
          </label>
          {isAdmin && (
            <span className={desktopStyles.desktopLabel}>
              {t("관리자: 아이콘을 끌어 위치를 바꿀 수 있습니다")}
            </span>
          )}
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
