"use client";

import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createApiJson } from "@/lib/client/api-json";
import { apiPath } from "@/lib/client/api-path";
import { errorMessage, isAbortError } from "@/lib/client/errors";
import { downloadFileName } from "@/lib/client/file-activation";
import {
  normalizePresenceSnapshot,
  presenceTabId,
} from "@/lib/client/presence-tab";
import {
  formatTransferBytes,
  nativeDownload,
  streamDownloadToDisk,
  type TransferProgress,
} from "@/lib/client/transfer";
import { uploadEntry } from "@/lib/client/upload-entry";
import { NOTICE_DURATION_MS, useAutoDismissNotice } from "@/lib/client/use-auto-dismiss-notice";
import {
  disableWidgetWall,
  enableWidgetWall,
  finishedGauge,
  isWidgetHidden,
  parseWallSide,
  type PinState,
  placementSteps,
  readWidgetMode,
  readWidgetPinned,
  readWidgetWall,
  recentWidgetFiles,
  reportWallZone,
  setWidgetPinned,
  sortWidgetEntries,
  type SettledTransfer,
  transferGauge,
  type TransferResult,
  WALL_GAUGE_HOLD_MS,
  type WallSide,
  wallZoneRect,
  WIDGET_LIST_POLL_MS,
  WIDGET_PINNED_EVENT,
  WIDGET_PRESENCE_MS,
  WIDGET_VISIBILITY_EVENT,
  WIDGET_WALL_HOVER_EVENT,
  WIDGET_WALL_SIDE_EVENT,
  widgetDownloadUrlData,
  widgetPlacement,
  widgetPollInterval,
  type WidgetMode,
  writeWidgetMode,
  writeWidgetWall,
} from "@/lib/client/widget";
import { LOCALE_BCP47, translate, type Locale } from "@/lib/i18n";
import type { PresenceMember, PresenceSnapshot } from "@/lib/presence";
import { canEdit, canUpload, type SessionRole } from "@/lib/roles";
import type { StorageStatus } from "@/lib/storage-quota";
import { type Entry, ROOT_ID } from "@/lib/storage/types";
import type { ShareLink } from "@/lib/share-links";
import PixelFileIcon from "../files/PixelFileIcon";
import WidgetBand from "./WidgetBand";
import styles from "./widget.module.css";

interface Crumb {
  id: string;
  name: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: Entry | null;
}

const STORAGE_POLL_MS = 60_000;
// widget.module.css의 .contextMenu 너비와 짝 — 화면 밖으로 나가지 않게 자리를 잡는 데만 쓴다
const CONTEXT_MENU_WIDTH = 196;
const CONTEXT_MENU_HEIGHT = 150;
// 파일 내려받기 경로 — 우클릭 메뉴 내려받기와 끌어내기(#29)가 함께 쓴다. 스페이스 안이면 apiPath가
// /<slug>/api/... 로 프리픽스를 붙인다.
const downloadPath = (entry: Entry) =>
  apiPath(`/api/drive/download?id=${encodeURIComponent(entry.id)}`);
// 모드(서랍/창가)와 벽 붙임 켜짐은 브라우저 저장소가 원본이다 — 같은 창의 다른 탭·다른 위젯
// 인스턴스 변경도 storage 이벤트로 따라온다. 저장한 쪽은 자기 이벤트를 쏴 같은 창의 구독자에게 알린다.
function storedSetting(eventName: string) {
  return {
    subscribe(onChange: () => void) {
      window.addEventListener(eventName, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(eventName, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    save(write: (storage: Storage) => void) {
      write(window.localStorage);
      window.dispatchEvent(new Event(eventName));
    },
  };
}

const modeSetting = storedSetting("sharedesk:widget-mode");
const wallSetting = storedSetting("sharedesk:widget-wall");

// 주기 확인 하나: 바로 한 번 부르고, 그다음은 baseMs 간격. 창이 트레이에 숨어 있으면
// (document.hidden 또는 껍데기의 숨김 표식) 훨씬 느리게 돈다.
// 효과가 끝나면 진행 중이던 호출이 돌아와도 되살아나지 않는다.
function useHiddenAwarePoll(run: () => Promise<void>, baseMs: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer = 0;
    const hidden = () => isWidgetHidden(document, window);
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        await run();
        if (cancelled) return;
        schedule(widgetPollInterval(baseMs, hidden()));
      }, delay);
    };
    const onVisibility = () =>
      schedule(hidden() ? widgetPollInterval(baseMs, true) : 0);
    schedule(0);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener(WIDGET_VISIBILITY_EVENT, onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener(WIDGET_VISIBILITY_EVENT, onVisibility);
    };
  }, [run, baseMs, enabled]);
}

export default function WidgetView({
  userName,
  isAdmin,
  role,
  locale,
}: {
  userName: string;
  isAdmin: boolean;
  role: SessionRole;
  locale: Locale;
}) {
  const router = useRouter();
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );
  const allowUpload = canUpload(role);
  const allowShare = canEdit(role);

  const mode = useSyncExternalStore(
    modeSetting.subscribe,
    () => readWidgetMode(window.localStorage),
    () => "desk" as WidgetMode,
  );
  const wallOn = useSyncExternalStore(
    wallSetting.subscribe,
    () => readWidgetWall(window.localStorage),
    () => false,
  );
  // 껍데기가 붙였다고 확인한 벽과 펼침 여부. 켜 달라고 했는데 아직 답이 없거나 거부되면 null.
  const [wall, setWall] = useState<{ side: WallSide; expanded: boolean } | null>(null);
  // 압정(#30) — 원본은 껍데기 설정. 로드 때 읽어 온다(그 전엔 unknown — 단추를 잠근다).
  const [pinned, setPinned] = useState<PinState>("unknown");
  const wallHandleRef = useRef<HTMLDivElement | null>(null);
  const [path, setPath] = useState<Crumb[]>([{ id: ROOT_ID, name: "ShareDesk" }]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [presence, setPresence] = useState<{
    count: number;
    members: PresenceMember[];
    error: boolean;
  }>({ count: 0, members: [], error: false });
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [transfers, setTransfers] = useState<Map<string, TransferProgress>>(
    () => new Map(),
  );
  // 지금 묶음(전송이 하나라도 있는 동안)에서 끝난 전송들 — 손잡이 게이지의 묶음 진행률과 완료 색(#31)
  const [settled, setSettled] = useState<SettledTransfer[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // 서랍에서 창 밖(탐색기)으로 끌고 있는 파일의 id (#29). 끄는 중인지는 아래 draggingOut이 목록에서 파생한다.
  const [dragOutId, setDragOutId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // 벽 붙임으로 접혀 있는 동안은 알림을 지우지 않는다 — 화면 밖에서 사라지지 않고, 펼치면 그때부터 센다(#31)
  const wallFolded = wallOn && wall !== null && !wall.expanded;
  const [notice, showNotice] = useAutoDismissNotice(NOTICE_DURATION_MS.default, wallFolded);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transfersRef = useRef(transfers);
  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);
  const folderId = path[path.length - 1].id;
  const folderName = path[path.length - 1].name;
  const isRoot = folderId === ROOT_ID;
  // 응답이 돌아온 시점에 사용자가 다른 폴더에 있으면 버린다 — 옛 폴더 목록이 새 폴더에 그려지지 않게
  const folderIdRef = useRef(folderId);
  useEffect(() => {
    folderIdRef.current = folderId;
  }, [folderId]);

  // ── 공용 요청 ────────────────────────────────────────────────────────

  const apiJson = useMemo(
    () =>
      createApiJson({
        translate: t,
        onUnauthorized: () => router.replace("/"),
        onForbidden: () => router.refresh(),
      }),
    [router, t],
  );

  function switchMode(next: WidgetMode) {
    modeSetting.save((storage) => writeWidgetMode(storage, next));
    setContextMenu(null);
  }

  // 배치(#30): 떠 있기·벽 붙임·압정 중 하나. 벽·압정 단추는 placementSteps의 차례대로 —
  // 켜려는 쪽의 반대편을 먼저 끄고 켠다. 벽을 끌 때는 껍데기 해제(disableWidgetWall)까지 기다린다.
  const placement = widgetPlacement(wallOn, pinned);

  async function togglePlacement(pressed: "wall" | "pinned") {
    setContextMenu(null);
    if (pressed === "pinned" && pinned === "unsupported") {
      // 옛 껍데기(명령 없음): 아무것도 바꾸지 않고 업데이트를 안내한다
      showNotice(t("위젯을 업데이트하면 압정을 쓸 수 있습니다"));
      return;
    }
    for (const step of placementSteps(placement, pressed)) {
      if ("wall" in step) {
        wallSetting.save((storage) => writeWidgetWall(storage, step.wall));
        if (!step.wall) await disableWidgetWall(window);
        continue;
      }
      const applied = await setWidgetPinned(window, step.pinned);
      if (applied === null) {
        showNotice(t("압정을 바꾸지 못했습니다"));
        return;
      }
      setPinned(applied);
    }
  }

  // ── 목록 ────────────────────────────────────────────────────────────

  const refreshList = useCallback(async () => {
    const requested = folderIdRef.current;
    try {
      const body = await apiJson<{ entries: Entry[] }>(
        apiPath(`/api/drive/list?folderId=${encodeURIComponent(requested)}`),
        { cache: "no-store" },
      );
      if (folderIdRef.current !== requested) return;
      setEntries(Array.isArray(body.entries) ? body.entries : []);
      setListError(null);
    } catch (error) {
      if (folderIdRef.current !== requested) return;
      setListError(errorMessage(error, t("목록을 불러오지 못했습니다")));
    }
  }, [apiJson, t]);

  // 폴더가 바뀌면 refreshFolder가 새 함수가 되어 주기 확인이 즉시 다시 시작된다
  const refreshFolder = useCallback(
    () => refreshList(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- folderId는 ref로 읽지만 폴더 이동마다 새 주기를 시작해야 한다
    [refreshList, folderId],
  );
  useHiddenAwarePoll(refreshFolder, WIDGET_LIST_POLL_MS);

  // ── 접속자 심장박동 ──────────────────────────────────────────────────

  const heartbeat = useCallback(async () => {
    try {
      const body = await apiJson<PresenceSnapshot>(apiPath("/api/presence"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: presenceTabId(),
          transfers: [...transfersRef.current.values()],
        }),
      });
      setPresence({ ...normalizePresenceSnapshot(body), error: false });
    } catch {
      setPresence((current) => ({ ...current, error: true }));
    }
  }, [apiJson]);
  useHiddenAwarePoll(heartbeat, WIDGET_PRESENCE_MS);

  // ── 용량(관리자, 창가 모드에서만) ────────────────────────────────────

  const loadStorage = useCallback(async () => {
    try {
      setStorage(
        await apiJson<StorageStatus>(apiPath("/api/storage/usage"), { cache: "no-store" }),
      );
    } catch {
      setStorage(null);
    }
  }, [apiJson]);
  useHiddenAwarePoll(loadStorage, STORAGE_POLL_MS, isAdmin && mode === "window");

  // ── 업로드 ───────────────────────────────────────────────────────────

  const reportTransfer = useCallback(
    (progress: TransferProgress | null, id: string) => {
      setTransfers((current) => {
        const next = new Map(current);
        if (progress) next.set(id, progress);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  const recordTransferResult = useCallback(
    (result: TransferResult, total: number | null) =>
      setSettled((current) => [...current, { result, total }]),
    [],
  );

  async function uploadFiles(files: FileList | File[]) {
    if (!allowUpload) return;
    const list = Array.from(files);
    if (!list.length) return;
    const targetFolder = folderId;
    const failed: string[] = [];
    // 놓는 순간 모든 파일을 전송 목록에 올린다(#31) — 게이지와 전송 바가 묶음 전체의 진행을 보여 주게.
    // 올리기는 지금처럼 하나씩 차례로 한다.
    const jobs = list.map((file) => ({ file, transferId: crypto.randomUUID() }));
    setTransfers((current) => {
      const next = new Map(current);
      for (const { file, transferId } of jobs) {
        next.set(transferId, {
          id: transferId,
          kind: "upload",
          name: file.name,
          transferred: 0,
          total: file.size,
        });
      }
      return next;
    });
    for (const { file, transferId } of jobs) {
      const update = (transferred: number, total: number) =>
        reportTransfer(
          { id: transferId, kind: "upload", name: file.name, transferred, total },
          transferId,
        );
      try {
        await uploadEntry(file, targetFolder, {
          apiJson,
          onProgress: update,
          onSessionExpired: () => router.replace("/"),
          messages: {
            driveFailed: t("드라이브 업로드에 실패했습니다"),
            sessionExpired: t("세션이 만료되었습니다"),
            uploadFailed: t("업로드에 실패했습니다"),
          },
        });
        recordTransferResult("ok", file.size);
      } catch (error) {
        failed.push(`${file.name}: ${errorMessage(error, t("실패"))}`);
        recordTransferResult("failed", file.size);
      } finally {
        reportTransfer(null, transferId);
      }
    }
    showNotice(
      failed.length
        ? t("일부 파일을 올리지 못했습니다 · {failures}", {
            failures: failed.join(" / "),
          })
        : t("{count}개 파일을 올렸습니다", { count: list.length }),
    );
    // 올리는 동안 다른 폴더로 옮겨 갔으면 지금 보는 폴더를 새로 읽는다
    await refreshList();
    void heartbeat();
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    // 올릴 수 없는 역할이어도 기본 동작(파일로 이동)은 막는다
    event.preventDefault();
    event.dataTransfer.dropEffect = allowUpload ? "copy" : "none";
    if (allowUpload) setDragOver(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragOver(false);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragOver(false);
    if (!allowUpload) return;
    const files = event.dataTransfer.files;
    if (files.length) void uploadFiles(files);
  }

  // ── 끌어내기 (#29) ───────────────────────────────────────────────────
  // 파일 아이콘을 탐색기 폴더에 놓으면 그 폴더에 받아진다(Windows). 놓는 순간 탐색기가 내려받기
  // 주소를 세션 쿠키와 함께 받아 간다. 드래그 이미지는 기본(아이콘 버튼 모양) 그대로 둔다.
  // DownloadURL만 싣는다 — text/plain까지 실으면 맥(WKWebView)은 DownloadURL은 버리고 글만 남겨
  // 파인더에 .textClipping 파일이 생길 수 있다. 탐색기 받기에는 DownloadURL이면 된다.
  function onIconDragStart(event: DragEvent<HTMLElement>, entry: Entry) {
    if (entry.isFolder) return;
    event.dataTransfer.effectAllowed = "copy";
    // Chromium(WebView2)의 끌어내기 형식 — 탐색기가 이 절대 주소를 받아 파일로 만든다
    event.dataTransfer.setData(
      "DownloadURL",
      widgetDownloadUrlData(entry, `${window.location.origin}${downloadPath(entry)}`),
    );
    setDragOutId(entry.id);
  }

  // ── 열기·내려받기·링크 ─────────────────────────────────────────────

  function moveTo(next: Crumb[]) {
    setContextMenu(null);
    setSelectedId(null);
    setEntries(null);
    setListError(null);
    setPath(next);
  }

  function enterFolder(entry: Entry) {
    moveTo([...path, { id: entry.id, name: entry.name }]);
  }

  function goBack() {
    if (path.length > 1) moveTo(path.slice(0, -1));
  }

  async function downloadEntry(entry: Entry) {
    setContextMenu(null);
    const id = crypto.randomUUID();
    const url = downloadPath(entry);
    // 전송 목록에 오른 뒤(저장 위치를 고르고 받기 시작한 뒤)의 결과만 게이지에 남긴다
    let started = false;
    let size: number | null = null;
    try {
      const result = await streamDownloadToDisk(
        url,
        downloadFileName(entry),
        (transferred, total) => {
          started = true;
          size = total;
          reportTransfer(
            { id, kind: "download", name: entry.name, transferred, total },
            id,
          );
        },
      );
      if (started) recordTransferResult("ok", size);
      if (result === "native") nativeDownload(url, downloadFileName(entry));
      else showNotice(t("{name}을(를) 저장했습니다", { name: entry.name }));
    } catch (error) {
      // 받는 도중의 취소(중단)도 실패로 친다
      if (started) recordTransferResult("failed", size);
      if (!isAbortError(error)) {
        showNotice(errorMessage(error, t("다운로드에 실패했습니다")));
      }
    } finally {
      reportTransfer(null, id);
    }
  }

  async function copyShareLink(entry: Entry) {
    setContextMenu(null);
    try {
      const body = await apiJson<{ link?: ShareLink }>(apiPath("/api/drive/share-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, expiresInHours: 1 }),
      });
      if (!body.link?.linkId) throw new Error(t("공유 링크를 만들지 못했습니다"));
      const url = `${window.location.origin}/api/share/${body.link.linkId}`;
      try {
        await navigator.clipboard.writeText(url);
        showNotice(t("1시간 공유 링크를 만들어 복사했습니다."));
      } catch {
        showNotice(url);
      }
    } catch (error) {
      showNotice(errorMessage(error, t("공유 링크를 만들지 못했습니다")));
    }
  }

  // 껍데기가 새 창 요청을 기본 브라우저로 보낸다 (widget/src-tauri/src/lib.rs on_new_window).
  // 스페이스 안이면 /<slug>/files — apiPath가 같은 규칙으로 프리픽스를 붙인다.
  function openInBrowser() {
    setContextMenu(null);
    window.open(`${window.location.origin}${apiPath("/files")}`, "_blank", "noopener");
  }

  function activate(entry: Entry) {
    if (entry.isFolder) enterFolder(entry);
    else void downloadEntry(entry);
  }

  function openContextMenu(event: ReactMouseEvent, entry: Entry | null) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(entry?.id ?? null);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - 4),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - 4),
      entry,
    });
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  // ── 파생 값 ─────────────────────────────────────────────────────────

  const bcp47 = LOCALE_BCP47[locale];
  const sorted = useMemo(
    () => (entries ? sortWidgetEntries(entries, bcp47) : []),
    [entries, bcp47],
  );
  const recent = useMemo(() => recentWidgetFiles(entries ?? []), [entries]);
  const activeTransfers = [...transfers.values()];
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(bcp47, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [bcp47],
  );
  const folderAddress =
    path.length === 1 ? "/" : `/${path.slice(1).map((crumb) => crumb.name).join("/")}`;
  const placeTitle = isRoot ? t("공유 바탕화면") : folderName;

  const storageLimit = storage
    ? (storage.deskStorageLimitBytes ?? storage.hostLimitBytes ?? null)
    : null;
  const donutStyle: CSSProperties | undefined =
    storage && storageLimit && storageLimit > 0
      ? ({
          "--used": `${Math.min(100, (storage.deskUsedBytes / storageLimit) * 100).toFixed(1)}%`,
          "--reserved": `${Math.min(100, ((storage.deskUsedBytes + storage.reservedBytes) / storageLimit) * 100).toFixed(1)}%`,
        } as CSSProperties)
      : undefined;

  // ── 벽 붙임 (#28) ─────────────────────────────────────────────────────
  // 껍데기(widget/src-tauri/src/wall.rs)가 창을 벽에 붙이고 커서를 본다. 화면은 위젯 전체를 벽 너머로
  // 밀어내 손잡이만 남기고, "마우스를 받아야 하는 영역"만 알린다. 펼침·접힘과 벽이 바뀌면
  // 껍데기가 sharedesk:wall-hover·sharedesk:wall-side 이벤트로 알려 준다.

  const wallState = wallOn ? wall : null;
  const wallActive = wallState !== null;
  const wallSide = wallState?.side ?? null;
  const wallExpanded = wallState?.expanded ?? false;
  // 커서가 떠나도 접지 않는 때: 우클릭 메뉴가 열려 있거나, 파일을 서랍 위로 끌고 있거나,
  // 서랍의 파일을 창 밖으로 끌어내는 중일 때(#29 — 끌고 나가는 동안 판이 접히지 않게).
  // 올리는 중에는 붙잡지 않는다(#31) — 접혀도 전송은 계속되고, 손잡이 테두리의 게이지가 진행을 보여 준다.
  // 끄는 도중 그 아이콘이 사라지면(주기 갱신에서 남이 지움·옮김, 다른 창에서 모드 전환) 브라우저는
  // dragend를 떨어져 나간 노드에만 쏘고 onDragEnd가 오지 않는다 — 그래서 끄는 중인지는 목록에 그
  // 아이콘이 아직 있는지로 판정한다. 그렇지 않으면 hold가 영영 풀리지 않아 벽 붙임이 다시 접히지 않는다.
  const draggingOut =
    dragOutId !== null && mode === "desk" && sorted.some((entry) => entry.id === dragOutId);
  // 끄는 중이 아니게 되면(아이콘이 사라짐) 끌던 id를 바로 비운다 — 같은 id가 다음 목록에 되살아나도
  // hold가 다시 켜지지 않게. 파생값으로 렌더 중에 비우므로 effect가 필요 없다.
  if (dragOutId !== null && !draggingOut) setDragOutId(null);
  const hold = contextMenu !== null || dragOver || draggingOut;

  // 전송 게이지(#31): 접힌 손잡이 테두리가 활성 전송의 합산 진행률만큼 아래에서 위로 초록으로 찬다.
  // 크기를 아는 전송이 없으면 전체가 깜빡이고(unknown). 묶음이 다 끝나면 하나라도 실패·취소였으면 빨강
  // 3초(failed), 아니면 다 찬 초록 1초(done)를 보인 뒤 원래 색으로. 끝난 순간은 렌더 중에 이전 값과 비교해
  // 알아채고, 표시를 푸는 것만 타이머가 맡는다.
  const transferring = activeTransfers.length > 0;
  const gaugeRatio = transferGauge(activeTransfers, settled);
  const [wasTransferring, setWasTransferring] = useState(false);
  const [finished, setFinished] = useState<"done" | "failed" | null>(null);
  if (transferring !== wasTransferring) {
    setWasTransferring(transferring);
    setFinished(transferring ? null : finishedGauge(settled));
    if (transferring) setSettled([]);
  }
  useEffect(() => {
    if (!finished) return;
    const timer = window.setTimeout(() => setFinished(null), WALL_GAUGE_HOLD_MS[finished]);
    return () => window.clearTimeout(timer);
  }, [finished]);
  const gaugeState = transferring
    ? gaugeRatio === null
      ? "unknown"
      : "progress"
    : (finished ?? undefined);
  const gaugeStyle =
    transferring && gaugeRatio !== null
      ? ({ "--gauge-ratio": String(gaugeRatio) } as CSSProperties)
      : undefined;

  // 켜져 있으면 로드될 때마다 껍데기에 다시 붙여 달라고 한다 (껍데기는 기억하지 않는다)
  useEffect(() => {
    if (!wallOn) return;
    let alive = true;
    const onHover = (event: Event) => {
      const expanded = (event as CustomEvent<unknown>).detail === true;
      setWall((current) => (current ? { ...current, expanded } : current));
    };
    const onSide = (event: Event) => {
      const side = parseWallSide((event as CustomEvent<unknown>).detail);
      if (side) setWall((current) => (current ? { ...current, side } : current));
    };
    document.addEventListener(WIDGET_WALL_HOVER_EVENT, onHover);
    document.addEventListener(WIDGET_WALL_SIDE_EVENT, onSide);
    void enableWidgetWall(window).then((result) => {
      if (!alive) return;
      if ("side" in result) {
        setWall({ side: result.side, expanded: false });
        return;
      }
      if (result.reason === "unsupported") {
        // 옛 껍데기(명령 없음): 표식을 끄고 떠 있는 위젯 그대로 두며 업데이트를 안내한다
        wallSetting.save((storage) => writeWidgetWall(storage, false));
        showNotice(t("위젯을 업데이트하면 벽 붙임을 쓸 수 있습니다"));
        return;
      }
      // 껍데기가 붙이지 못했다: 표식은 두고(다음 로드에 다시 시도) 알리기만 한다
      showNotice(t("벽에 붙이지 못했습니다"));
    });
    return () => {
      alive = false;
      document.removeEventListener(WIDGET_WALL_HOVER_EVENT, onHover);
      document.removeEventListener(WIDGET_WALL_SIDE_EVENT, onSide);
      setWall(null);
      void disableWidgetWall(window);
    };
  }, [wallOn, showNotice, t]);

  // 벽 붙임 중에는 창 바탕을 비운다 — 위젯 모드의 밤색 body(globals.css)가 빈 자리에 남지 않게
  useEffect(() => {
    if (!wallActive) return;
    const root = document.documentElement;
    root.setAttribute("data-widget-wall", "");
    return () => root.removeAttribute("data-widget-wall");
  }, [wallActive]);

  // 마우스를 받아야 하는 영역: 숨김 중엔 손잡이(+여유), 펼침 중엔 창 전체
  useEffect(() => {
    if (!wallActive) return;
    const report = () => {
      const handle = wallHandleRef.current;
      if (!handle) return;
      void reportWallZone(window, {
        rect: wallZoneRect(wallExpanded, handle.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
        hold,
      });
    };
    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, [wallActive, wallSide, wallExpanded, hold]);

  // ── 압정 (#30) ───────────────────────────────────────────────────────
  // 로드 때 껍데기에서 압정 여부를 읽고, 껍데기가 스스로 풀면(트레이 "항상 위", 벽 붙임 요청) 따라간다.

  useEffect(() => {
    let alive = true;
    const onPinned = (event: Event) => setPinned((event as CustomEvent<unknown>).detail === true);
    document.addEventListener(WIDGET_PINNED_EVENT, onPinned);
    void readWidgetPinned(window).then((value) => {
      if (alive) setPinned(value);
    });
    return () => {
      alive = false;
      document.removeEventListener(WIDGET_PINNED_EVENT, onPinned);
    };
  }, []);

  // ── 화면 ─────────────────────────────────────────────────────────────

  return (
    <div
      className={styles.widget}
      data-mode={mode}
      data-wall={wallSide ?? undefined}
      data-wall-expanded={wallExpanded ? "" : undefined}
      onContextMenu={(event) => {
        // 빈 곳 우클릭 — 아이콘·메뉴 밖에서만 바탕 메뉴를 연다
        if (mode === "desk") openContextMenu(event, null);
        else event.preventDefault();
      }}
    >
      <div className={styles.wallpaper} aria-hidden="true" />
      <WidgetBand title={placeTitle}>
        <span
          className={`${styles.liveDot} ${presence.error ? styles.liveDotError : ""}`}
          title={presence.error ? t("접속 확인 실패") : t("접속자 · {count}명", { count: presence.count })}
          aria-hidden="true"
        />
        <div className={styles.modeSwitch} role="group" aria-label={t("위젯 모드")}>
          <button
            type="button"
            className={styles.bandButton}
            aria-pressed={mode === "desk"}
            title={t("서랍 — 파일을 놓고 여는 미니 데스크")}
            onClick={() => switchMode("desk")}
          >
            {t("서랍")}
          </button>
          <button
            type="button"
            className={styles.bandButton}
            aria-pressed={mode === "window"}
            title={t("창가 — 접속자와 최근 파일")}
            onClick={() => switchMode("window")}
          >
            {t("창가")}
          </button>
        </div>
        <div className={styles.modeSwitch} role="group" aria-label={t("위젯 배치")}>
          <button
            type="button"
            className={styles.bandButton}
            aria-pressed={placement === "wall"}
            title={t("벽 붙임 — 화면 가장자리에 숨겨 두고, 손잡이에 마우스를 대면 펼칩니다")}
            onClick={() => void togglePlacement("wall")}
          >
            {t("벽")}
          </button>
          <button
            type="button"
            className={styles.bandButton}
            aria-pressed={placement === "pinned"}
            disabled={pinned === "unknown"}
            title={t("바탕화면에 압정처럼 고정 — 다른 창 뒤, 바탕화면 위에 머무릅니다")}
            onClick={() => void togglePlacement("pinned")}
          >
            {t("압정")}
          </button>
        </div>
      </WidgetBand>

      {mode === "desk" ? (
        <section
          className={styles.desk}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          aria-label={isRoot ? t("공유 바탕화면") : t("폴더 내용")}
        >
          {!isRoot && (
            <div className={styles.crumbs}>
              <button type="button" className={styles.bandButton} onClick={goBack}>
                ← {t("뒤로")}
              </button>
              <span title={folderAddress}>{folderAddress}</span>
            </div>
          )}
          <div
            className={styles.grid}
            role="listbox"
            aria-label={t("공유 바탕화면 아이콘")}
            aria-busy={entries === null}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSelectedId(null);
            }}
          >
            {listError && (
              <div className={styles.empty} role="alert">
                <strong>{t("목록을 불러오지 못했습니다")}</strong>
                <span>{listError}</span>
                <button type="button" className={styles.bandButton} onClick={() => void refreshList()}>
                  {t("다시 확인")}
                </button>
              </div>
            )}
            {!listError && entries !== null && sorted.length === 0 && (
              <div className={styles.empty}>
                <strong>{isRoot ? t("아직 올린 파일이 없습니다") : t("빈 폴더입니다")}</strong>
                {allowUpload && <span>{t("파일을 여기에 놓으면 데스크에 올라갑니다")}</span>}
              </div>
            )}
            {sorted.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={selectedId === entry.id}
                className={`${styles.icon} ${selectedId === entry.id ? styles.iconSelected : ""}`}
                title={entry.name}
                draggable={!entry.isFolder}
                onDragStart={(event) => onIconDragStart(event, entry)}
                onDragEnd={() => setDragOutId(null)}
                onClick={() => setSelectedId(entry.id)}
                onDoubleClick={() => activate(entry)}
                onContextMenu={(event) => openContextMenu(event, entry)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") activate(entry);
                }}
              >
                <PixelFileIcon entry={entry} size={40} />
                <span className={styles.iconName}>{entry.name}</span>
              </button>
            ))}
          </div>
          {dragOver && (
            <div className={styles.dropOverlay}>
              <strong>{t("여기에 놓기")}</strong>
              <span>{isRoot ? t("공유 바탕화면에 올립니다") : t("이 폴더에 올립니다")}</span>
            </div>
          )}
          {activeTransfers.length > 0 && (
            <div className={styles.transferBar} aria-live="polite">
              <span>
                {activeTransfers[0].kind === "upload"
                  ? t("올리는 중 {count}개", { count: activeTransfers.length })
                  : t("받는 중 {count}개", { count: activeTransfers.length })}
                {" · "}
                {activeTransfers[0].name}
              </span>
              <em>
                {activeTransfers[0].total
                  ? `${Math.round((activeTransfers[0].transferred / activeTransfers[0].total) * 100)}%`
                  : formatTransferBytes(activeTransfers[0].transferred)}
              </em>
              <progress
                max={activeTransfers[0].total ?? undefined}
                value={activeTransfers[0].total ? activeTransfers[0].transferred : undefined}
              />
            </div>
          )}
        </section>
      ) : (
        <section className={styles.windowMode} aria-label={t("창가")}>
          <div className={styles.panel}>
            <h2>
              {t("현재 접속 인원")}
              <small>{presence.error ? t("접속 확인 실패") : t("{count}명", { count: presence.count })}</small>
            </h2>
            {presence.members.length === 0 ? (
              <p className={styles.muted}>{t("접속 중인 사람이 없습니다")}</p>
            ) : (
              <ul>
                {presence.members.map((member, index) => {
                  const busy = member.transfers.length > 0;
                  return (
                    <li key={`${member.name}-${index}`} className={styles.member}>
                      <span className={styles.memberDot} aria-hidden="true" />
                      <span>{member.isSelf ? userName : member.name}</span>
                      {member.isSelf ? (
                        <em className={styles.tag}>{t("나")}</em>
                      ) : busy ? (
                        <em className={`${styles.tag} ${styles.tagBusy}`}>{t("전송 중")}</em>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className={styles.panel}>
            <h2>
              {t("최근 올라온 파일")}
              <small title={folderAddress}>{placeTitle}</small>
            </h2>
            {entries === null ? (
              <p className={styles.muted}>{t("확인하고 있습니다")}</p>
            ) : recent.length === 0 ? (
              <p className={styles.muted}>{t("아직 올린 파일이 없습니다")}</p>
            ) : (
              <ul>
                {recent.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={styles.recent}
                      title={t("파일 내려받기")}
                      onClick={() => void downloadEntry(entry)}
                    >
                      <PixelFileIcon entry={entry} size={20} />
                      <span>{entry.name}</span>
                      <time dateTime={entry.modifiedAt ?? undefined}>
                        {entry.modifiedAt ? timeFormat.format(new Date(entry.modifiedAt)) : ""}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {isAdmin && storage && (
            <div className={styles.panel}>
              <h2>{t("데스크 용량")}</h2>
              <div className={styles.storage}>
                <div className={styles.donut} style={donutStyle} aria-hidden="true" />
                <div className={styles.storageRows}>
                  <span>
                    {t("사용 중")}
                    <b>{formatTransferBytes(storage.deskUsedBytes)}</b>
                  </span>
                  {storage.reservedBytes > 0 && (
                    <span>
                      {t("올리는 중")}
                      <b>{formatTransferBytes(storage.reservedBytes)}</b>
                    </span>
                  )}
                  <span>
                    {t("제한")}
                    <b>{storageLimit ? formatTransferBytes(storageLimit) : t("없음")}</b>
                  </span>
                </div>
              </div>
            </div>
          )}

          <button type="button" className={styles.wide} onClick={openInBrowser}>
            ↗ {t("브라우저에서 데스크 열기")}
          </button>
        </section>
      )}

      {allowUpload && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label={t("파일 올리기…")}
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files?.length) void uploadFiles(files);
            event.currentTarget.value = "";
          }}
        />
      )}

      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}

      {contextMenu && (
        <div
          className={styles.contextMenu}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.entry ? (
            contextMenu.entry.isFolder ? (
              <button type="button" role="menuitem" className={styles.menuItem} onClick={() => enterFolder(contextMenu.entry!)}>
                {t("열기")}
              </button>
            ) : (
              <>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void downloadEntry(contextMenu.entry!)}>
                  {t("파일 내려받기")}
                </button>
                {allowShare && (
                  <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void copyShareLink(contextMenu.entry!)}>
                    {t("1시간 링크 복사")}
                  </button>
                )}
              </>
            )
          ) : (
            <>
              {allowUpload && (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setContextMenu(null);
                    fileInputRef.current?.click();
                  }}
                >
                  {t("파일 올리기…")}
                </button>
              )}
              <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setContextMenu(null); void refreshList(); }}>
                {t("새로고침")}
              </button>
            </>
          )}
          <div className={styles.menuSeparator} aria-hidden="true" />
          <button type="button" role="menuitem" className={styles.menuItem} onClick={openInBrowser}>
            {t("브라우저에서 데스크 열기")}
          </button>
        </div>
      )}

      {wallState &&
        // 벽에 남는 손잡이 — 위젯(.widget)이 벽 너머로 밀려나도 제자리에 남도록 body에 따로 그린다.
        // 숨김 중엔 창이 클릭을 뒤로 넘기므로 누를 수 없다. 커서(파일을 끌고 올 때 포함)를 대면
        // 껍데기의 커서 판정이 펼친다.
        createPortal(
          <div
            ref={wallHandleRef}
            className={styles.wallHandle}
            data-side={wallState.side}
            data-expanded={wallState.expanded ? "" : undefined}
            data-gauge={gaugeState}
            style={gaugeStyle}
            aria-hidden="true"
          >
            <span className={styles.wallBrand}>
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className={`${styles.liveDot} ${presence.error ? styles.liveDotError : ""}`} />
          </div>,
          document.body,
        )}
    </div>
  );
}
