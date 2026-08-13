"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import {
  classifyMoveFailure,
  confirmedMoveEntries,
  dragTerminalAction,
  foldersAwaitingIdle,
  isDragPointer,
  needsDetachedFolderRefresh,
  shouldRetryFolderReconciliation,
  windowsContainingFolder,
} from "@/lib/client/file-move";
import { fileActivationAction } from "@/lib/client/file-activation";
import {
  streamDownloadToDisk,
  transferProgressText,
  type TransferProgress,
  uploadWithProgress,
} from "@/lib/client/transfer";
import { previewKindOf, type PreviewKind } from "@/lib/preview";
import PixelFileIcon from "./PixelFileIcon";
import ShareDialog from "./ShareDialog";
import styles from "./desktop.module.css";
import {
  fitLogicalRect,
  folderAddress,
  logicalClientCoordinate,
  logicalPointerDelta,
  logicalViewportFor,
  nextNotepadName,
  reconcileSavedDraft,
  renamedCrumbsFromEntries,
  uiScaleForViewport,
} from "./ui-scale";

type Entry = {
  id: string;
  layoutKey: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  modifiedAt: string | null;
  mimeType: string | null;
  version: string | null;
};

type UploadSession =
  | { mode: "direct"; url: string }
  | { mode: "proxy" };

type Placement = { x: number; y: number; version: number };

type LayoutSnapshot = {
  folderIdentity: string | null;
  revision: number;
  positions: Record<string, Placement>;
};

type FolderData = LayoutSnapshot & {
  entries: Entry[];
  loading: boolean;
  error: string | null;
  layoutError: string | null;
};

type Crumb = { id: string; name: string };

type TrashEntry = Entry & { version: string; trashedAt: string | null };

type PreviewWindowState = {
  instanceId: number;
  entry: Entry;
  kind: PreviewKind;
  x: number;
  y: number;
  z: number;
  text: string | null;
  originalText: string | null;
  textLoading: boolean;
  textError: string | null;
  textSaveError: string | null;
  textReadOnlyReason: string | null;
  textSaving: boolean;
  textConflict: boolean;
};

type FolderNoteWindowState = {
  instanceId: number;
  folderId: string;
  folderName: string;
  path: Crumb[];
  x: number;
  y: number;
  z: number;
  content: string;
  originalContent: string;
  version: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: boolean;
};

type DragGhostState = {
  entry: Entry;
  clientX: number;
  clientY: number;
};

type InternalDropTarget =
  | { kind: "folder"; folderId: string; highlightKey: string }
  | { kind: "trash"; highlightKey: "trash" };

type AddressState = {
  value: string;
  busy: boolean;
  error: string | null;
};

type PresenceMember = {
  name: string;
  isSelf: boolean;
  transfers: Array<TransferProgress & { updatedAt: number }>;
};

type PresenceState = {
  count: number;
  members: PresenceMember[];
  loading: boolean;
  error: string | null;
  open: boolean;
};

type TrashWindowState = {
  x: number;
  y: number;
  z: number;
  entries: TrashEntry[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  confirmId: string | null; // 완전삭제 2단계 확인 대상 ("__empty__"는 비우기)
};

type DeskWindow = {
  id: string;
  path: Crumb[];
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  restoreRect?: { x: number; y: number; width: number; height: number };
  data: FolderData;
};

type ContextMenuState = {
  x: number;
  y: number;
  scopeId: string;
  entry?: Entry;
  opener: HTMLElement | null;
};

type ScopedRequest = {
  generation: number;
  controller: AbortController;
};

type LayoutSaveNode = {
  scopeId: string;
  folderId: string;
  folderIdentity: string;
  generation: number;
  entry: Entry;
  controller: AbortController | null;
  next: { x: number; y: number } | null;
  inFlight: boolean;
  baseVersion: number;
};

type DialogState =
  | { kind: "create"; scopeId: string; value: string }
  | { kind: "rename"; scopeId: string; entry: Entry; value: string }
  | { kind: "delete"; scopeId: string; entry: Entry };

const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ROOT_ID = "root";
const ROOT_SCOPE = "desktop";
// 배경은 개인 취향이라 공유 상태가 아닌 localStorage에 저장한다 (왕복 0·충돌 0).
const WALLPAPER_STORAGE_KEY = "sharedesk.wallpaper";
const DOWNLOAD_FIRST_STORAGE_KEY = "sharedesk.download-first";
const WALLPAPERS = [
  { id: "dusk", name: "해 질 녘", src: "/art/sharedesk-dusk.png" },
  { id: "night", name: "깊은 밤", src: "/art/wall-night.png" },
  { id: "dawn", name: "새벽", src: "/art/wall-dawn.png" },
  { id: "tide", name: "밤바다", src: "/art/wall-tide.png" },
] as const;
type WallpaperId = (typeof WALLPAPERS)[number]["id"];
const TOP_BAR = 34;
const TASK_BAR = 58;
const ICON_WIDTH = 88;
const ICON_HEIGHT = 94;
const ICON_COLUMN_WIDTH = 96;
const ICON_ROW_HEIGHT = 104;
const ICON_COLUMNS = 6;
const ICON_INSET_X = 12;
const ICON_INSET_Y = 10;
const PLANE_MIN_WIDTH = 600;
const PLANE_MIN_HEIGHT = 220;
const MAX_LOGICAL_COORDINATE = 1_000_000;
const LAYOUT_POLL_MS = 5_000;
const LIST_POLL_MS = 30_000;
const PRESENCE_HEARTBEAT_MS = 30_000;
const DETACHED_LIST_SCOPE_PREFIX = "detached-folder:";
const TEXT_EDIT_LIMIT = 1024 * 1024;

function TrashCanIcon() {
  return (
    <svg
      className={styles.trashLauncherGlyph}
      viewBox="0 0 32 36"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 14H29L27 36H11Z" fill="#0a1020" />
      <path d="M7 12H27L25 34H9Z" fill="#1b1b2f" />
      <path d="M10 15H24L22 31H12Z" fill="#aab4a7" />
      <path d="M12 15H15L14 29H12Z" fill="#eef1dc" />
      <path d="M17 15H19V29H17Z" fill="#65756f" />
      <path d="M21 15H23L22 29H20Z" fill="#65756f" />
      <path d="M12 29H22V31H12Z" fill="#7f8f86" />
      <path d="M5 8H29V14H3V10H5Z" fill="#0a1020" />
      <path d="M3 6H27V8H29V12H1V8H3Z" fill="#1b1b2f" />
      <path d="M5 8H25V10H3V8Z" fill="#d9dfcf" />
      <path d="M11 0H21V2H23V6H19V4H13V6H9V2H11Z" fill="#1b1b2f" />
      <path d="M13 2H19V4H13Z" fill="#eef1dc" />
    </svg>
  );
}

function blankFolder(loading = true): FolderData {
  return {
    entries: [],
    folderIdentity: null,
    positions: {},
    revision: 0,
    loading,
    error: null,
    layoutError: null,
  };
}

function mergeFolderData(current: FolderData, incoming: FolderData): FolderData {
  if (
    current.folderIdentity &&
    incoming.folderIdentity &&
    current.folderIdentity !== incoming.folderIdentity
  ) {
    return incoming;
  }
  if (incoming.revision >= current.revision) return incoming;
  return {
    ...incoming,
    revision: current.revision,
    positions: current.positions,
  };
}

function sortedEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.isFolder === b.isFolder
      ? a.name.localeCompare(b.name, "ko")
      : a.isFolder
        ? -1
        : 1,
  );
}

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

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function detachedListScope(folderId: string) {
  return `${DETACHED_LIST_SCOPE_PREFIX}${folderId}`;
}

function defaultPlacement(index: number): Placement {
  const column = index % ICON_COLUMNS;
  const row = Math.floor(index / ICON_COLUMNS);
  return {
    x: ICON_INSET_X + column * ICON_COLUMN_WIDTH,
    y: ICON_INSET_Y + row * ICON_ROW_HEIGHT,
    version: 0,
  };
}

function beginScopedRequest(
  requests: Map<string, ScopedRequest>,
  scopeId: string,
) {
  const previous = requests.get(scopeId);
  previous?.controller.abort();
  const request = {
    generation: (previous?.generation ?? 0) + 1,
    controller: new AbortController(),
  };
  requests.set(scopeId, request);
  return request;
}

function cancelScopedRequest(
  requests: Map<string, ScopedRequest>,
  scopeId: string,
) {
  requests.get(scopeId)?.controller.abort();
  requests.delete(scopeId);
}

function finishScopedRequest(
  requests: Map<string, ScopedRequest>,
  scopeId: string,
  request: ScopedRequest,
) {
  if (requests.get(scopeId) === request) requests.delete(scopeId);
}

function abortAllRequests(requests: Map<string, ScopedRequest>) {
  for (const request of requests.values()) request.controller.abort();
  requests.clear();
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatSize(bytes: number | null) {
  if (bytes === null) return "폴더";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(iso: string | null) {
  if (!iso) return "수정일 없음";
  return new Date(iso).toLocaleString("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

function previewUrl(entry: Entry) {
  return `/api/drive/download?id=${encodeURIComponent(entry.id)}&disposition=inline`;
}

function isEditableTextEntry(entry: Entry) {
  return entry.name.toLocaleLowerCase("en-US").endsWith(".txt");
}

function previewTextReadOnlyReason(preview: PreviewWindowState) {
  if (preview.textReadOnlyReason) return preview.textReadOnlyReason;
  if (!isEditableTextEntry(preview.entry)) {
    return ".txt 파일만 여기에서 편집할 수 있습니다.";
  }
  if (!preview.entry.version) {
    return "최신 버전 정보를 확인할 수 없어 읽기 전용입니다. 새로고침 후 다시 열어 주세요.";
  }
  return null;
}

function MenuButton({
  children,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`${styles.menuItem} ${danger ? styles.menuDanger : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function FilesView({
  userName,
  isAdmin,
  isGuest,
}: {
  userName: string;
  isAdmin: boolean;
  isGuest: boolean;
}) {
  const router = useRouter();
  const viewport = useViewport();
  const uiScale = uiScaleForViewport(viewport.width, viewport.height);
  const logicalViewport = logicalViewportFor(
    viewport.width,
    viewport.height,
    uiScale,
  );
  const rootCanvasRef = useRef<HTMLDivElement>(null);
  const windowCanvasRefs = useRef(new Map<string, HTMLDivElement>());
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const shareDialogOpenerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const previewOpenerRef = useRef<{
    element: HTMLElement;
    scopeId: string;
    entryId: string;
  } | null>(null);
  const deskButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadScopeRef = useRef(ROOT_SCOPE);
  const rootDataRef = useRef<FolderData>(blankFolder());
  const windowsRef = useRef<DeskWindow[]>([]);
  const listRequestsRef = useRef(new Map<string, ScopedRequest>());
  const layoutRequestsRef = useRef(new Map<string, ScopedRequest>());
  const addressRequestsRef = useRef(new Map<string, ScopedRequest>());
  const previewInstanceRef = useRef(0);
  const previewLoadControllerRef = useRef<AbortController | null>(null);
  const previewSaveControllerRef = useRef<AbortController | null>(null);
  const previewWindowRef = useRef<PreviewWindowState | null>(null);
  const folderNoteInstanceRef = useRef(0);
  const folderNoteLoadControllerRef = useRef<AbortController | null>(null);
  const folderNoteSaveControllerRef = useRef<AbortController | null>(null);
  const folderNoteWindowRef = useRef<FolderNoteWindowState | null>(null);
  const presenceControllerRef = useRef<AbortController | null>(null);
  const presenceReadControllerRef = useRef<AbortController | null>(null);
  const presenceRequestIdRef = useRef(0);
  const presenceReadRequestIdRef = useRef(0);
  const presenceTabIdRef = useRef("");
  const activeTransfersRef = useRef(new Map<string, TransferProgress>());
  const transferStartedAtRef = useRef(new Map<string, number>());
  const transferRemovalTimersRef = useRef(new Map<string, number>());
  const presenceReportTimerRef = useRef<number | null>(null);
  const folderMutationVersionsRef = useRef(new Map<string, number>());
  const pendingFolderMutationsRef = useRef(new Map<string, number>());
  const folderIdleWaitersRef = useRef(
    new Map<string, Set<() => void>>(),
  );
  const foldersNeedingRefreshRef = useRef(new Set<string>());
  const savingPositionKeysRef = useRef(new Set<string>());
  const movingEntryIdsRef = useRef(new Set<string>());
  // 아이콘별 저장 큐 — 저장 중에도 자유롭게 다시 끌 수 있고, 항상 최신 좌표
  // 하나만 전송한다. 서버 왕복(구글 업로드 ~2초)이 체감되지 않게 하는 장치.
  const saveQueueRef = useRef(new Map<string, LayoutSaveNode>());
  const layoutSaveGenerationsRef = useRef(new Map<string, number>());
  const invalidateLayoutSavesForIdentityChangeRef = useRef<
    (
      scopeId: string,
      currentIdentity: string | null,
      incomingIdentity: string | null,
    ) => void
  >(() => undefined);
  const applySnapshotRef = useRef<
    (scopeId: string, folderId: string, snapshot: LayoutSnapshot) => void
  >(() => undefined);
  const draggingKeyRef = useRef<string | null>(null);
  const zRef = useRef(20);
  const windowIdRef = useRef(0);
  const suppressedClickRef = useRef(new Set<string>());

  const [rootData, setRootData] = useState<FolderData>(() => blankFolder());
  const [deskWindows, setDeskWindows] = useState<DeskWindow[]>([]);
  const [selected, setSelected] = useState<{
    scopeId: string;
    layoutKey: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [shareEntry, setShareEntry] = useState<Entry | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOverScope, setDragOverScope] = useState<string | null>(null);
  const [activeTransfers, setActiveTransfers] = useState<TransferProgress[]>([]);
  const [transientPositions, setTransientPositions] = useState<
    Record<string, Placement>
  >({});
  const [savingPositions, setSavingPositions] = useState<Set<string>>(
    () => new Set(),
  );
  const [clock, setClock] = useState<Date | null>(null);
  // 아이콘 드래그로 이동할 때: 끌리는 아이콘(히트테스트 제외용)과 드롭 대상 하이라이트.
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [trashWindow, setTrashWindow] = useState<TrashWindowState | null>(null);
  const [previewWindow, setPreviewWindow] =
    useState<PreviewWindowState | null>(null);
  const [folderNoteWindow, setFolderNoteWindow] =
    useState<FolderNoteWindowState | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhostState | null>(null);
  const [addressStates, setAddressStates] = useState<
    Record<string, AddressState>
  >({});
  const [presence, setPresence] = useState<PresenceState>({
    count: 0,
    members: [],
    loading: true,
    error: null,
    open: false,
  });
  const [previewFocusRequest, setPreviewFocusRequest] = useState(0);
  const [downloadFirst, setDownloadFirst] = useState(false);
  // SSR과 첫 하이드레이션은 기본 배경으로 그리고, 저장된 선택은 마운트 후 적용한다.
  const [wallpaperId, setWallpaperId] = useState<WallpaperId>("dusk");

  rootDataRef.current = rootData;
  windowsRef.current = deskWindows;
  previewWindowRef.current = previewWindow;
  folderNoteWindowRef.current = folderNoteWindow;
  const dialogOpen = dialog !== null;

  const fetchFolder = useCallback(
    async (folderId: string, signal: AbortSignal): Promise<FolderData> => {
      const listResponse = await fetch(
        `/api/drive/list?folderId=${encodeURIComponent(folderId)}`,
        { cache: "no-store", signal },
      );
      if (listResponse.status === 401) {
        router.replace("/");
        throw new Error("세션이 만료되었습니다");
      }
      const listBody = await listResponse.json().catch(() => null);
      if (!listResponse.ok) {
        throw new Error(listBody?.error ?? "폴더를 불러오지 못했습니다");
      }

      const snapshot: LayoutSnapshot = listBody.layout ?? {
        folderIdentity: null,
        revision: 0,
        positions: {},
      };
      const layoutError =
        typeof listBody.layoutError === "string" ? listBody.layoutError : null;

      return {
        entries: Array.isArray(listBody.entries) ? listBody.entries : [],
        folderIdentity: snapshot.folderIdentity ?? null,
        positions: snapshot.positions ?? {},
        revision: snapshot.revision ?? 0,
        loading: false,
        error: null,
        layoutError,
      };
    },
    [router],
  );

  const loadRoot = useCallback(
    async (quiet = false) => {
      if ((pendingFolderMutationsRef.current.get(ROOT_ID) ?? 0) > 0) {
        foldersNeedingRefreshRef.current.add(ROOT_ID);
        return false;
      }
      const request = beginScopedRequest(listRequestsRef.current, ROOT_SCOPE);
      const mutationVersion = folderMutationVersionsRef.current.get(ROOT_ID) ?? 0;
      if (!quiet) {
        setRootData((current) => ({ ...current, loading: true, error: null }));
      }
      try {
        const data = await fetchFolder(ROOT_ID, request.controller.signal);
        if (
          listRequestsRef.current.get(ROOT_SCOPE) !== request ||
          (pendingFolderMutationsRef.current.get(ROOT_ID) ?? 0) > 0 ||
          (folderMutationVersionsRef.current.get(ROOT_ID) ?? 0) !==
            mutationVersion
        ) {
          if (
            (pendingFolderMutationsRef.current.get(ROOT_ID) ?? 0) > 0 ||
            (folderMutationVersionsRef.current.get(ROOT_ID) ?? 0) !==
              mutationVersion
          ) {
            foldersNeedingRefreshRef.current.add(ROOT_ID);
          }
          return false;
        }
        invalidateLayoutSavesForIdentityChangeRef.current(
          ROOT_SCOPE,
          rootDataRef.current.folderIdentity,
          data.folderIdentity,
        );
        propagateFolderNames(data.entries);
        setRootData((current) =>
          (folderMutationVersionsRef.current.get(ROOT_ID) ?? 0) ===
          mutationVersion
            ? mergeFolderData(current, data)
            : current,
        );
        return true;
      } catch (error) {
        if (
          isAbortError(error) ||
          listRequestsRef.current.get(ROOT_SCOPE) !== request ||
          (folderMutationVersionsRef.current.get(ROOT_ID) ?? 0) !==
            mutationVersion
        ) {
          if (
            (pendingFolderMutationsRef.current.get(ROOT_ID) ?? 0) > 0 ||
            (folderMutationVersionsRef.current.get(ROOT_ID) ?? 0) !==
              mutationVersion
          ) {
            foldersNeedingRefreshRef.current.add(ROOT_ID);
          }
          return false;
        }
        setRootData((current) => ({
          ...current,
          loading: false,
          error: errorMessage(error, "바탕화면을 불러오지 못했습니다"),
        }));
        return false;
      } finally {
        finishScopedRequest(listRequestsRef.current, ROOT_SCOPE, request);
      }
    },
    [fetchFolder],
  );

  const loadDeskWindow = useCallback(
    async (windowId: string, folderId: string, quiet = false) => {
      if ((pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0) {
        foldersNeedingRefreshRef.current.add(folderId);
        return false;
      }
      const request = beginScopedRequest(listRequestsRef.current, windowId);
      const mutationVersion =
        folderMutationVersionsRef.current.get(folderId) ?? 0;
      if (!quiet) {
        setDeskWindows((current) =>
          current.map((item) =>
            item.id === windowId && item.path.at(-1)?.id === folderId
              ? { ...item, data: { ...item.data, loading: true, error: null } }
              : item,
          ),
        );
      }
      try {
        const data = await fetchFolder(folderId, request.controller.signal);
        if (
          listRequestsRef.current.get(windowId) !== request ||
          (pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0 ||
          (folderMutationVersionsRef.current.get(folderId) ?? 0) !==
            mutationVersion
        ) {
          if (
            (pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0 ||
            (folderMutationVersionsRef.current.get(folderId) ?? 0) !==
              mutationVersion
          ) {
            foldersNeedingRefreshRef.current.add(folderId);
          }
          return false;
        }
        const currentWindow = windowsRef.current.find(
          (item) => item.id === windowId && item.path.at(-1)?.id === folderId,
        );
        invalidateLayoutSavesForIdentityChangeRef.current(
          windowId,
          currentWindow?.data.folderIdentity ?? null,
          data.folderIdentity,
        );
        propagateFolderNames(data.entries);
        setDeskWindows((current) =>
          (folderMutationVersionsRef.current.get(folderId) ?? 0) ===
          mutationVersion
            ? current.map((item) =>
                item.id === windowId && item.path.at(-1)?.id === folderId
                  ? { ...item, data: mergeFolderData(item.data, data) }
                  : item,
              )
            : current,
        );
        return true;
      } catch (error) {
        if (
          isAbortError(error) ||
          listRequestsRef.current.get(windowId) !== request ||
          (folderMutationVersionsRef.current.get(folderId) ?? 0) !==
            mutationVersion
        ) {
          if (
            (pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0 ||
            (folderMutationVersionsRef.current.get(folderId) ?? 0) !==
              mutationVersion
          ) {
            foldersNeedingRefreshRef.current.add(folderId);
          }
          return false;
        }
        setDeskWindows((current) =>
          current.map((item) =>
            item.id === windowId && item.path.at(-1)?.id === folderId
              ? {
                  ...item,
                  data: {
                    ...item.data,
                    loading: false,
                    error: errorMessage(
                      error,
                      "폴더를 불러오지 못했습니다",
                    ),
                  },
                }
              : item,
          ),
        );
        return false;
      } finally {
        finishScopedRequest(listRequestsRef.current, windowId, request);
      }
    },
    [fetchFolder],
  );

  const loadLayout = useCallback(
    async (scopeId: string, folderId: string) => {
      const request = beginScopedRequest(layoutRequestsRef.current, scopeId);
      try {
        const response = await fetch(
          `/api/desktop/layout?folderId=${encodeURIComponent(folderId)}`,
          { cache: "no-store", signal: request.controller.signal },
        );
        if (response.status === 401) {
          router.replace("/");
          throw new Error("세션이 만료되었습니다");
        }
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error ?? "공유 배치를 불러오지 못했습니다");
        }
        if (layoutRequestsRef.current.get(scopeId) !== request) return;
        // 저장 응답과 같은 병합 규칙(revision 단조성 + layoutError 초기화)을 쓴다.
        applySnapshotRef.current(scopeId, folderId, body as LayoutSnapshot);
      } catch (error) {
        if (
          isAbortError(error) ||
          layoutRequestsRef.current.get(scopeId) !== request
        ) {
          return;
        }
        const layoutError = errorMessage(
          error,
          "공유 배치를 불러오지 못했습니다",
        );
        if (scopeId === ROOT_SCOPE) {
          setRootData((current) => ({ ...current, layoutError }));
          return;
        }
        setDeskWindows((current) =>
          current.map((item) =>
            item.id === scopeId && item.path.at(-1)?.id === folderId
              ? { ...item, data: { ...item.data, layoutError } }
              : item,
          ),
        );
      } finally {
        finishScopedRequest(layoutRequestsRef.current, scopeId, request);
      }
    },
    [router],
  );

  useEffect(() => {
    const initial = window.setTimeout(() => void loadRoot(), 0);
    const layoutPoll = window.setInterval(() => {
      void loadLayout(ROOT_SCOPE, ROOT_ID);
      for (const item of windowsRef.current) {
        const folderId = item.path.at(-1)?.id;
        if (folderId && !item.minimized) {
          void loadLayout(item.id, folderId);
        }
      }
    }, LAYOUT_POLL_MS);
    const listPoll = window.setInterval(() => {
      void loadRoot(true);
      for (const item of windowsRef.current) {
        const folderId = item.path.at(-1)?.id;
        if (folderId && !item.minimized) {
          void loadDeskWindow(item.id, folderId, true);
        }
      }
    }, LIST_POLL_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(layoutPoll);
      window.clearInterval(listPoll);
    };
  }, [loadDeskWindow, loadLayout, loadRoot]);

  const getPresenceTabId = useCallback(() => {
    if (presenceTabIdRef.current) return presenceTabIdRef.current;
    let tabId = "";
    try {
      tabId = window.sessionStorage.getItem("sharedesk.presence-tab") ?? "";
    } catch {
      // 저장소가 막힌 브라우저에서는 이 탭을 연 동안만 식별값을 유지한다.
    }
    presenceTabIdRef.current = tabId || crypto.randomUUID();
    if (!tabId) {
      try {
        window.sessionStorage.setItem(
          "sharedesk.presence-tab",
          presenceTabIdRef.current,
        );
      } catch {
        // 메모리에 든 식별값만으로도 현재 탭은 분리된다.
      }
    }
    return presenceTabIdRef.current;
  }, []);

  const applyPresenceSnapshot = useCallback((body: unknown) => {
    const snapshot = body as Partial<PresenceState> | null;
    setPresence((current) => ({
      ...current,
      count: Number.isSafeInteger(snapshot?.count) ? snapshot!.count! : 0,
      members: Array.isArray(snapshot?.members)
        ? snapshot.members.filter(
            (member: unknown): member is PresenceMember =>
              !!member &&
              typeof member === "object" &&
              typeof (member as PresenceMember).name === "string" &&
              typeof (member as PresenceMember).isSelf === "boolean" &&
              Array.isArray((member as PresenceMember).transfers),
          )
        : [],
      loading: false,
      error: null,
    }));
  }, []);

  const refreshPresence = useCallback(async () => {
    const requestId = presenceRequestIdRef.current + 1;
    presenceRequestIdRef.current = requestId;
    presenceControllerRef.current?.abort();
    const controller = new AbortController();
    presenceControllerRef.current = controller;
    setPresence((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetch("/api/presence", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: getPresenceTabId(),
          transfers: [...activeTransfersRef.current.values()],
        }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        router.replace("/");
        return;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "접속 인원을 불러오지 못했습니다");
      }
      if (presenceRequestIdRef.current !== requestId) return;
      applyPresenceSnapshot(body);
    } catch (error) {
      if (
        controller.signal.aborted ||
        presenceRequestIdRef.current !== requestId
      ) {
        return;
      }
      setPresence((current) => ({
        ...current,
        loading: false,
        error: errorMessage(error, "접속 인원을 불러오지 못했습니다"),
      }));
    } finally {
      if (presenceControllerRef.current === controller) {
        presenceControllerRef.current = null;
      }
    }
  }, [applyPresenceSnapshot, getPresenceTabId, router]);

  const readPresence = useCallback(async () => {
    const requestId = presenceReadRequestIdRef.current + 1;
    presenceReadRequestIdRef.current = requestId;
    presenceReadControllerRef.current?.abort();
    const controller = new AbortController();
    presenceReadControllerRef.current = controller;
    try {
      const response = await fetch("/api/presence", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401) {
        router.replace("/");
        return;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "접속 인원을 불러오지 못했습니다");
      }
      if (presenceReadRequestIdRef.current !== requestId) return;
      applyPresenceSnapshot(body);
    } catch (error) {
      if (
        controller.signal.aborted ||
        presenceReadRequestIdRef.current !== requestId
      ) {
        return;
      }
      setPresence((current) => ({
        ...current,
        loading: false,
        error: errorMessage(error, "접속 인원을 불러오지 못했습니다"),
      }));
    } finally {
      if (presenceReadControllerRef.current === controller) {
        presenceReadControllerRef.current = null;
      }
    }
  }, [applyPresenceSnapshot, router]);

  const reportTransferProgress = useCallback(
    (transfer: TransferProgress | null, removeId?: string) => {
      if (removeId) {
        const remove = () => {
          transferRemovalTimersRef.current.delete(removeId);
          transferStartedAtRef.current.delete(removeId);
          activeTransfersRef.current.delete(removeId);
          setActiveTransfers([...activeTransfersRef.current.values()]);
          void refreshPresence();
        };
        const visibleFor =
          Date.now() - (transferStartedAtRef.current.get(removeId) ?? 0);
        const delay = Math.max(0, 1_500 - visibleFor);
        const previous = transferRemovalTimersRef.current.get(removeId);
        if (previous !== undefined) window.clearTimeout(previous);
        if (delay > 0) {
          transferRemovalTimersRef.current.set(
            removeId,
            window.setTimeout(remove, delay),
          );
        } else {
          remove();
        }
        return;
      }
      if (!transfer) return;
      const isNew = !activeTransfersRef.current.has(transfer.id);
      if (isNew) transferStartedAtRef.current.set(transfer.id, Date.now());
      activeTransfersRef.current.set(transfer.id, transfer);
      setActiveTransfers([...activeTransfersRef.current.values()]);
      if (isNew) {
        void refreshPresence();
        return;
      }
      if (presenceReportTimerRef.current !== null) return;
      presenceReportTimerRef.current = window.setTimeout(() => {
        presenceReportTimerRef.current = null;
        void refreshPresence();
      }, 1_000);
    },
    [refreshPresence],
  );

  useEffect(() => {
    getPresenceTabId();
    const removalTimers = transferRemovalTimersRef.current;
    let timer: number | null = null;
    const start = () => {
      if (document.visibilityState !== "visible") return;
      void refreshPresence();
      if (timer === null) {
        timer = window.setInterval(() => {
          if (document.visibilityState === "visible") void refreshPresence();
        }, PRESENCE_HEARTBEAT_MS);
      }
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      presenceControllerRef.current?.abort();
      presenceControllerRef.current = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
      presenceRequestIdRef.current += 1;
      presenceReadRequestIdRef.current += 1;
      presenceReadControllerRef.current?.abort();
      presenceReadControllerRef.current = null;
      if (presenceReportTimerRef.current !== null) {
        window.clearTimeout(presenceReportTimerRef.current);
        presenceReportTimerRef.current = null;
      }
      for (const timer of removalTimers.values()) {
        window.clearTimeout(timer);
      }
      removalTimers.clear();
    };
  }, [getPresenceTabId, refreshPresence]);

  useEffect(() => {
    if (!presence.open || document.visibilityState !== "visible") return;
    void readPresence();
    const timer = window.setInterval(() => void readPresence(), 1_000);
    return () => window.clearInterval(timer);
  }, [presence.open, readPresence]);

  useEffect(
    () => () => {
      abortAllRequests(listRequestsRef.current);
      abortAllRequests(layoutRequestsRef.current);
      abortAllRequests(addressRequestsRef.current);
      previewLoadControllerRef.current?.abort();
      previewSaveControllerRef.current?.abort();
      folderNoteLoadControllerRef.current?.abort();
      folderNoteSaveControllerRef.current?.abort();
      for (const node of saveQueueRef.current.values()) {
        node.controller?.abort();
      }
      saveQueueRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    setClock(new Date());
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(WALLPAPER_STORAGE_KEY);
      if (saved && WALLPAPERS.some((w) => w.id === saved)) {
        setWallpaperId(saved as WallpaperId);
      }
      setDownloadFirst(
        window.localStorage.getItem(DOWNLOAD_FIRST_STORAGE_KEY) === "true",
      );
    } catch {
      // 저장소 접근이 막힌 브라우저에서는 기본값을 쓴다.
    }
  }, []);

  useEffect(() => {
    const resizedViewport = {
      width: logicalViewport.width,
      height: logicalViewport.height,
    };
    const folderBounds = {
      left: 6,
      top: TOP_BAR + 6,
      right: 6,
      bottom: TASK_BAR + 6,
      minWidth: 390,
      minHeight: 300,
    };
    const fitFloatingWindow = (
      x: number,
      y: number,
      width: number,
      height: number,
    ) =>
      fitLogicalRect(
        { x, y, width, height },
        resizedViewport,
        {
          left: 8,
          top: TOP_BAR + 6,
          right: 8,
          bottom: TASK_BAR + 6,
          minWidth: width,
          minHeight: height,
        },
      );

    setDeskWindows((current) =>
      current.map((item) => {
        const fitted = fitLogicalRect(
          item,
          resizedViewport,
          folderBounds,
          item.maximized,
        );
        return {
          ...item,
          ...fitted,
          restoreRect: item.restoreRect
            ? fitLogicalRect(
                item.restoreRect,
                resizedViewport,
                folderBounds,
              )
            : undefined,
        };
      }),
    );
    setTrashWindow((current) => {
      if (!current) return current;
      const fitted = fitFloatingWindow(
        current.x,
        current.y,
        Math.max(320, Math.min(480, resizedViewport.width - 16)),
        Math.max(240, Math.min(400, resizedViewport.height - 120)),
      );
      return { ...current, x: fitted.x, y: fitted.y };
    });
    setPreviewWindow((current) => {
      if (!current) return current;
      const fitted = fitFloatingWindow(
        current.x,
        current.y,
        Math.max(320, Math.min(760, resizedViewport.width - 24)),
        Math.max(240, Math.min(560, resizedViewport.height - 140)),
      );
      return { ...current, x: fitted.x, y: fitted.y };
    });
    setFolderNoteWindow((current) => {
      if (!current) return current;
      const fitted = fitFloatingWindow(
        current.x,
        current.y,
        Math.max(360, Math.min(560, resizedViewport.width - 24)),
        Math.max(250, Math.min(420, resizedViewport.height - 140)),
      );
      return { ...current, x: fitted.x, y: fitted.y };
    });
    setContextMenu((current) => {
      if (!current) return current;
      const hasParent = Boolean(
        current.scopeId !== ROOT_SCOPE &&
          windowsRef.current
            .find((item) => item.id === current.scopeId)
            ?.path.at(-2),
      );
      const height = current.entry
        ? (isAdmin ? 250 : 205) + (hasParent ? 45 : 0)
        : current.scopeId === ROOT_SCOPE
          ? 330
          : 194;
      return {
        ...current,
        x: clamp(
          current.x,
          8,
          Math.max(8, resizedViewport.width - 210 - 8),
        ),
        y: clamp(
          current.y,
          8,
          Math.max(8, resizedViewport.height - height - 8),
        ),
      };
    });
  }, [isAdmin, logicalViewport.height, logicalViewport.width]);

  function selectWallpaper(id: WallpaperId) {
    setWallpaperId(id);
    try {
      window.localStorage.setItem(WALLPAPER_STORAGE_KEY, id);
    } catch {
      // 시크릿 모드 등에서 저장이 막혀도 이번 세션 동안은 적용된다.
    }
    setContextMenu(null);
  }

  function selectDownloadFirst(enabled: boolean) {
    setDownloadFirst(enabled);
    try {
      window.localStorage.setItem(
        DOWNLOAD_FIRST_STORAGE_KEY,
        String(enabled),
      );
    } catch {
      // 저장이 막혀도 현재 탭에서는 선택을 유지한다.
    }
  }

  useEffect(() => {
    if (!contextMenu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      contextMenuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!dialogOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      const opener = dialogOpenerRef.current;
      dialogOpenerRef.current = null;
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [dialogOpen]);

  useEffect(() => {
    if (!previewFocusRequest) return;
    const focusFrame = window.requestAnimationFrame(() => {
      previewRef.current
        ?.querySelector<HTMLElement>("[data-preview-initial-focus]")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [previewFocusRequest]);

  async function apiJson<T>(pathname: string, init: RequestInit): Promise<T> {
    const response = await fetch(pathname, init);
    if (response.status === 401) {
      router.replace("/");
      const error = new Error("세션이 만료되었습니다");
      Object.assign(error, { status: response.status });
      throw error;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error ?? "요청에 실패했습니다");
      Object.assign(error, { status: response.status });
      throw error;
    }
    return body as T;
  }

  function scopeWindow(scopeId: string) {
    return deskWindows.find((item) => item.id === scopeId);
  }

  function scopeData(scopeId: string) {
    return scopeId === ROOT_SCOPE ? rootData : scopeWindow(scopeId)?.data;
  }

  function scopeFolderId(scopeId: string) {
    if (scopeId === ROOT_SCOPE) return ROOT_ID;
    return scopeWindow(scopeId)?.path.at(-1)?.id ?? ROOT_ID;
  }

  function scopeParentFolderId(scopeId: string) {
    if (scopeId === ROOT_SCOPE) return null;
    return scopeWindow(scopeId)?.path.at(-2)?.id ?? null;
  }

  function entryContextMenuHeight(scopeId: string) {
    return (isAdmin ? 250 : 205) + (scopeParentFolderId(scopeId) ? 45 : 0);
  }

  function scopeCanvas(scopeId: string) {
    return scopeId === ROOT_SCOPE
      ? rootCanvasRef.current
      : windowCanvasRefs.current.get(scopeId) ?? null;
  }

  function findEntryButton(scopeId: string, entryId: string) {
    return Array.from(
      scopeCanvas(scopeId)?.querySelectorAll<HTMLButtonElement>(
        "button[data-entry-id]",
      ) ?? [],
    ).find((button) => button.dataset.entryId === entryId);
  }

  function focusAfterDelete(
    scopeId: string,
    deletedEntryId: string,
    candidateEntryIds: string[],
  ) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const canvas = scopeCanvas(scopeId);
        const remainingButtons = Array.from(
          canvas?.querySelectorAll<HTMLButtonElement>(
            "button[data-entry-id]",
          ) ?? [],
        ).filter((button) => button.dataset.entryId !== deletedEntryId);
        const candidate = candidateEntryIds
          .map((entryId) =>
            remainingButtons.find(
              (button) => button.dataset.entryId === entryId,
            ),
          )
          .find((button): button is HTMLButtonElement => !!button);
        (candidate ?? remainingButtons[0] ?? canvas ?? deskButtonRef.current)?.focus();
      });
    });
  }

  function refreshScope(scopeId: string, quiet = false) {
    if (scopeId === ROOT_SCOPE) return loadRoot(quiet);
    return loadDeskWindow(scopeId, scopeFolderId(scopeId), quiet);
  }

  function markFolderMutation(folderId: string) {
    folderMutationVersionsRef.current.set(
      folderId,
      (folderMutationVersionsRef.current.get(folderId) ?? 0) + 1,
    );
  }

  function waitForFolderIdle(folderId: string) {
    if ((pendingFolderMutationsRef.current.get(folderId) ?? 0) === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters = folderIdleWaitersRef.current.get(folderId) ?? new Set();
      waiters.add(resolve);
      folderIdleWaitersRef.current.set(folderId, waiters);
    });
  }

  function notifyFolderIdle(folderId: string) {
    const waiters = folderIdleWaitersRef.current.get(folderId);
    if (!waiters) return;
    folderIdleWaitersRef.current.delete(folderId);
    for (const resolve of waiters) resolve();
  }

  async function waitForFoldersIdle(folderIds: string[]) {
    while (true) {
      const pendingFolderIds = foldersAwaitingIdle(
        folderIds,
        pendingFolderMutationsRef.current,
      );
      if (pendingFolderIds.length === 0) return;
      await Promise.all(pendingFolderIds.map(waitForFolderIdle));
    }
  }

  function folderMutationSnapshot(folderIds: string[]) {
    return new Map(
      folderIds.map((folderId) => [
        folderId,
        folderMutationVersionsRef.current.get(folderId) ?? 0,
      ] as const),
    );
  }

  function cancelFolderListRequests(folderId: string): boolean {
    let interruptedRequest = false;
    let incompleteView = false;
    const detachedScope = detachedListScope(folderId);
    if (listRequestsRef.current.has(detachedScope)) {
      interruptedRequest = true;
      cancelScopedRequest(listRequestsRef.current, detachedScope);
    }
    if (folderId === ROOT_ID) {
      incompleteView ||= rootData.loading;
      if (listRequestsRef.current.has(ROOT_SCOPE)) {
        interruptedRequest = true;
        cancelScopedRequest(listRequestsRef.current, ROOT_SCOPE);
      }
    }
    for (const item of windowsRef.current) {
      if (item.path.at(-1)?.id !== folderId) continue;
      incompleteView ||= item.data.loading;
      if (listRequestsRef.current.has(item.id)) {
        interruptedRequest = true;
        cancelScopedRequest(listRequestsRef.current, item.id);
      }
    }
    if (interruptedRequest || incompleteView) {
      foldersNeedingRefreshRef.current.add(folderId);
    }
    return interruptedRequest;
  }

  function updateFolderEntries(
    folderId: string,
    update: (entries: Entry[]) => Entry[],
  ) {
    if (folderId === ROOT_ID) {
      setRootData((current) => ({
        ...current,
        entries: update(current.entries),
      }));
    }
    setDeskWindows((current) =>
      current.map((item) =>
        item.path.at(-1)?.id === folderId
          ? { ...item, data: { ...item.data, entries: update(item.data.entries) } }
          : item,
      ),
    );
  }

  function removeFolderEntry(folderId: string, entryId: string) {
    updateFolderEntries(folderId, (entries) =>
      entries.filter((entry) => entry.id !== entryId),
    );
  }

  function upsertFolderEntry(folderId: string, entry: Entry) {
    updateFolderEntries(folderId, (entries) =>
      sortedEntries([
        ...entries.filter((current) => current.id !== entry.id),
        entry,
      ]),
    );
  }

  async function refreshDetachedFolder(folderId: string) {
    if ((pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0) {
      foldersNeedingRefreshRef.current.add(folderId);
      return false;
    }
    const scopeId = detachedListScope(folderId);
    const request = beginScopedRequest(listRequestsRef.current, scopeId);
    const mutationVersion = folderMutationVersionsRef.current.get(folderId) ?? 0;
    try {
      await fetchFolder(folderId, request.controller.signal);
      if (
        listRequestsRef.current.get(scopeId) !== request ||
        (pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0 ||
        (folderMutationVersionsRef.current.get(folderId) ?? 0) !== mutationVersion
      ) {
        if (
          (pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0 ||
          (folderMutationVersionsRef.current.get(folderId) ?? 0) !== mutationVersion
        ) {
          foldersNeedingRefreshRef.current.add(folderId);
        }
        return false;
      }
      return true;
    } catch (error) {
      if (
        isAbortError(error) ||
        listRequestsRef.current.get(scopeId) !== request ||
        (folderMutationVersionsRef.current.get(folderId) ?? 0) !== mutationVersion
      ) {
        if (
          (pendingFolderMutationsRef.current.get(folderId) ?? 0) > 0 ||
          (folderMutationVersionsRef.current.get(folderId) ?? 0) !== mutationVersion
        ) {
          foldersNeedingRefreshRef.current.add(folderId);
        }
        return false;
      }
      return false;
    } finally {
      finishScopedRequest(listRequestsRef.current, scopeId, request);
    }
  }

  async function refreshFolderInstances(folderId: string) {
    const jobs: Promise<boolean>[] = [];
    if (folderId === ROOT_ID) jobs.push(loadRoot(true));
    for (const item of windowsRef.current) {
      if (item.path.at(-1)?.id === folderId) {
        jobs.push(loadDeskWindow(item.id, folderId, true));
      }
    }
    if (needsDetachedFolderRefresh(jobs.length)) {
      jobs.push(refreshDetachedFolder(folderId));
    }
    const results = await Promise.all(jobs);
    return results.every(Boolean);
  }

  async function refreshFolders(folderIds: string[]) {
    const results = await Promise.all(
      folderIds.map((folderId) => refreshFolderInstances(folderId)),
    );
    return results.every(Boolean);
  }

  function layoutSaveGeneration(scopeId: string) {
    return layoutSaveGenerationsRef.current.get(scopeId) ?? 0;
  }

  function cancelLayoutSaves(scopeId: string) {
    layoutSaveGenerationsRef.current.set(
      scopeId,
      layoutSaveGeneration(scopeId) + 1,
    );
    const cancelledKeys: string[] = [];
    for (const [key, node] of saveQueueRef.current) {
      if (node.scopeId !== scopeId) continue;
      node.next = null;
      node.controller?.abort();
      saveQueueRef.current.delete(key);
      savingPositionKeysRef.current.delete(key);
      cancelledKeys.push(key);
    }
    if (cancelledKeys.length === 0) return;
    const cancelled = new Set(cancelledKeys);
    setSavingPositions((current) => {
      const next = new Set(current);
      for (const key of cancelled) next.delete(key);
      return next;
    });
    setTransientPositions((current) => {
      const next = { ...current };
      for (const key of cancelled) delete next[key];
      return next;
    });
  }

  function invalidateLayoutSavesForIdentityChange(
    scopeId: string,
    currentIdentity: string | null,
    incomingIdentity: string | null,
  ) {
    if (
      currentIdentity &&
      incomingIdentity &&
      currentIdentity !== incomingIdentity
    ) {
      cancelScopedRequest(layoutRequestsRef.current, scopeId);
      cancelLayoutSaves(scopeId);
    }
  }
  invalidateLayoutSavesForIdentityChangeRef.current =
    invalidateLayoutSavesForIdentityChange;

  function cancelScopeRequests(scopeId: string) {
    cancelScopedRequest(listRequestsRef.current, scopeId);
    cancelScopedRequest(layoutRequestsRef.current, scopeId);
    cancelLayoutSaves(scopeId);
    cancelScopedRequest(addressRequestsRef.current, scopeId);
  }

  function beginPreviewInstance() {
    previewLoadControllerRef.current?.abort();
    previewSaveControllerRef.current?.abort();
    previewLoadControllerRef.current = null;
    previewSaveControllerRef.current = null;
    const instanceId = previewInstanceRef.current + 1;
    previewInstanceRef.current = instanceId;
    return instanceId;
  }

  function cancelPreviewRequests() {
    previewLoadControllerRef.current?.abort();
    previewSaveControllerRef.current?.abort();
    previewLoadControllerRef.current = null;
    previewSaveControllerRef.current = null;
    previewInstanceRef.current += 1;
  }

  function beginFolderNoteInstance() {
    folderNoteLoadControllerRef.current?.abort();
    folderNoteSaveControllerRef.current?.abort();
    folderNoteLoadControllerRef.current = null;
    folderNoteSaveControllerRef.current = null;
    const instanceId = folderNoteInstanceRef.current + 1;
    folderNoteInstanceRef.current = instanceId;
    return instanceId;
  }

  function closeFolderNote() {
    folderNoteLoadControllerRef.current?.abort();
    folderNoteSaveControllerRef.current?.abort();
    folderNoteLoadControllerRef.current = null;
    folderNoteSaveControllerRef.current = null;
    folderNoteInstanceRef.current += 1;
    folderNoteWindowRef.current = null;
    setFolderNoteWindow(null);
  }

  function closeWindow(windowId: string) {
    cancelScopeRequests(windowId);
    setDeskWindows((current) =>
      current.filter((item) => item.id !== windowId),
    );
    setSelected((current) =>
      current?.scopeId === windowId ? null : current,
    );
    setAddressStates((current) => {
      const next = { ...current };
      delete next[windowId];
      return next;
    });
  }

  function closeWindowsContainingFolder(folderId: string) {
    const affected = windowsContainingFolder(windowsRef.current, folderId);
    const noteAffected = Boolean(
      folderNoteWindowRef.current?.path.some((crumb) => crumb.id === folderId),
    );
    if (affected.length === 0 && !noteAffected) return;
    const affectedWindowIds = new Set(affected.map((item) => item.id));
    const affectedEntryIds = new Set(
      affected.flatMap((item) => item.data.entries.map((entry) => entry.id)),
    );
    for (const windowId of affectedWindowIds) cancelScopeRequests(windowId);
    setDeskWindows((current) =>
      current.filter((item) => !affectedWindowIds.has(item.id)),
    );
    setSelected((current) =>
      current && affectedWindowIds.has(current.scopeId) ? null : current,
    );
    setAddressStates((current) => {
      const next = { ...current };
      for (const windowId of affectedWindowIds) delete next[windowId];
      return next;
    });
    const previewAffected = Boolean(
      previewWindowRef.current &&
        (affectedEntryIds.has(previewWindowRef.current.entry.id) ||
          affectedWindowIds.has(previewOpenerRef.current?.scopeId ?? "")),
    );
    if (previewAffected) {
      previewOpenerRef.current = null;
      cancelPreviewRequests();
      previewWindowRef.current = null;
      setPreviewWindow(null);
    }
    if (noteAffected) closeFolderNote();
  }

  function updateRenamedFolder(folderId: string, replacement: Crumb) {
    const affected = windowsRef.current.filter((item) =>
      item.path.some((crumb) => crumb.id === folderId),
    );
    for (const item of affected) {
      cancelScopedRequest(addressRequestsRef.current, item.id);
    }
    setDeskWindows((current) =>
      current.map((item) =>
        item.path.some((crumb) => crumb.id === folderId)
          ? {
              ...item,
              path: item.path.map((crumb) =>
                crumb.id === folderId ? replacement : crumb,
              ),
            }
          : item,
      ),
    );
    setAddressStates((current) => {
      const next = { ...current };
      for (const item of affected) {
        const path = item.path.map((crumb) =>
          crumb.id === folderId ? replacement : crumb,
        );
        next[item.id] = {
          value: folderAddress(path),
          busy: false,
          error: null,
        };
      }
      return next;
    });
    setFolderNoteWindow((current) => {
      if (!current?.path.some((crumb) => crumb.id === folderId)) {
        return current;
      }
      const path = current.path.map((crumb) =>
        crumb.id === folderId ? replacement : crumb,
      );
      return {
        ...current,
        folderId:
          current.folderId === folderId ? replacement.id : current.folderId,
        folderName: path.at(-1)?.name ?? current.folderName,
        path,
      };
    });
  }

  function propagateFolderNames(entries: Entry[]) {
    const changedPaths = new Map<string, Crumb[]>();
    for (const item of windowsRef.current) {
      const path = renamedCrumbsFromEntries(item.path, entries);
      if (path !== item.path) changedPaths.set(item.id, path);
    }
    if (changedPaths.size > 0) {
      for (const windowId of changedPaths.keys()) {
        cancelScopedRequest(addressRequestsRef.current, windowId);
      }
      setDeskWindows((current) =>
        current.map((item) => {
          const path = changedPaths.get(item.id);
          return path ? { ...item, path } : item;
        }),
      );
      setAddressStates((current) => {
        const next = { ...current };
        for (const [windowId, path] of changedPaths) {
          next[windowId] = {
            value: folderAddress(path),
            busy: false,
            error: null,
          };
        }
        return next;
      });
    }
    setFolderNoteWindow((current) => {
      if (!current) return current;
      const path = renamedCrumbsFromEntries(current.path, entries);
      return path === current.path
        ? current
        : {
            ...current,
            folderName: path.at(-1)?.name ?? current.folderName,
            path,
          };
    });
  }

  function focusWindow(windowId: string) {
    const z = ++zRef.current;
    setDeskWindows((current) =>
      current.map((item) =>
        item.id === windowId
          ? { ...item, z, minimized: false }
          : item,
      ),
    );
  }

  function openFolder(entry: Entry, scopeId: string) {
    setContextMenu(null);
    if (scopeId !== ROOT_SCOPE) {
      const currentWindow = scopeWindow(scopeId);
      const nextPath = [
        ...(currentWindow?.path ?? [{ id: ROOT_ID, name: "ShareDesk" }]),
        { id: entry.id, name: entry.name },
      ];
      cancelScopeRequests(scopeId);
      setSelected((current) =>
        current?.scopeId === scopeId ? null : current,
      );
      setDeskWindows((current) =>
        current.map((item) =>
          item.id === scopeId
            ? {
                ...item,
                path: nextPath,
                data: blankFolder(),
              }
            : item,
        ),
      );
      setAddressStates((current) => ({
        ...current,
        [scopeId]: {
          value: folderAddress(nextPath),
          busy: false,
          error: null,
        },
      }));
      void loadDeskWindow(scopeId, entry.id);
      return;
    }

    const existing = deskWindows.find(
      (item) => item.path.at(-1)?.id === entry.id,
    );
    if (existing) {
      focusWindow(existing.id);
      return;
    }

    const id = `folder-${++windowIdRef.current}`;
    const width = Math.min(
      720,
      Math.max(390, logicalViewport.width - 48),
    );
    const height = Math.min(
      500,
      Math.max(300, logicalViewport.height - 112),
    );
    const cascade = (windowIdRef.current % 5) * 24;
    const x = clamp(
      (logicalViewport.width - width) / 2 + cascade - 48,
      8,
      Math.max(8, logicalViewport.width - width - 8),
    );
    const y = clamp(
      TOP_BAR + 28 + cascade,
      TOP_BAR + 6,
      Math.max(
        TOP_BAR + 6,
        logicalViewport.height - TASK_BAR - height - 6,
      ),
    );
    const next: DeskWindow = {
      id,
      path: [
        { id: ROOT_ID, name: "ShareDesk" },
        { id: entry.id, name: entry.name },
      ],
      x,
      y,
      width,
      height,
      z: ++zRef.current,
      minimized: false,
      maximized: false,
      data: blankFolder(),
    };
    setDeskWindows((current) => [...current, next]);
    void loadDeskWindow(id, entry.id);
  }

  function nativeDownload(entry: Entry) {
    const anchor = document.createElement("a");
    anchor.href = `/api/drive/download?id=${encodeURIComponent(entry.id)}`;
    anchor.download = entry.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function downloadEntry(entry: Entry) {
    const id = crypto.randomUUID();
    const url = `/api/drive/download?id=${encodeURIComponent(entry.id)}`;
    try {
      const result = await streamDownloadToDisk(
        url,
        entry.name,
        (transferred, total) =>
          reportTransferProgress({
            id,
            kind: "download",
            name: entry.name,
            transferred,
            total,
          }),
      );
      if (result === "native") {
        nativeDownload(entry);
        setNotice(
          "브라우저 다운로드로 넘겼습니다. 이 브라우저에서는 진행량을 확인할 수 없습니다.",
        );
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setNotice(errorMessage(error, "다운로드에 실패했습니다"));
      }
    } finally {
      reportTransferProgress(null, id);
    }
  }

  async function loadPreviewText(entry: Entry, instanceId: number) {
    const controller = new AbortController();
    previewLoadControllerRef.current = controller;
    try {
      const response = await fetch(previewUrl(entry), {
        cache: "no-store",
        headers: { Range: `bytes=0-${TEXT_EDIT_LIMIT}` },
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 206) {
        throw new Error("내용을 불러오지 못했습니다");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentRange = response.headers.get("content-range");
      const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1];
      const totalBytes = rangeTotal ? Number(rangeTotal) : entry.size;
      const truncated =
        bytes.byteLength > TEXT_EDIT_LIMIT ||
        (totalBytes !== null && totalBytes > TEXT_EDIT_LIMIT);
      const shownBytes = bytes.subarray(0, TEXT_EDIT_LIMIT);
      let invalidUtf8 = false;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(shownBytes);
      } catch {
        invalidUtf8 = true;
        text = new TextDecoder().decode(shownBytes);
      }
      const readOnlyReason = invalidUtf8
        ? "올바른 UTF-8 텍스트가 아니어서 글자가 손상될 수 있습니다. 이 화면에서는 저장할 수 없습니다."
        : truncated
          ? "1 MiB를 넘는 파일은 앞부분만 표시하며 읽기 전용입니다."
          : null;
      if (previewInstanceRef.current !== instanceId) return;
      setPreviewWindow((current) =>
        current?.instanceId === instanceId && current.entry.id === entry.id
          ? {
              ...current,
              text,
              originalText: text,
              textLoading: false,
              textReadOnlyReason: readOnlyReason,
            }
          : current,
      );
    } catch (error) {
      if (
        isAbortError(error) ||
        previewInstanceRef.current !== instanceId
      ) {
        return;
      }
      setPreviewWindow((current) =>
        current?.instanceId === instanceId && current.entry.id === entry.id
          ? {
              ...current,
              textLoading: false,
              textError: errorMessage(error, "내용을 불러오지 못했습니다"),
            }
          : current,
      );
    } finally {
      if (previewLoadControllerRef.current === controller) {
        previewLoadControllerRef.current = null;
      }
    }
  }

  function replaceEntryEverywhere(entry: Entry) {
    setRootData((current) => ({
      ...current,
      entries: current.entries.map((value) =>
        value.id === entry.id ? entry : value,
      ),
    }));
    setDeskWindows((current) =>
      current.map((item) => ({
        ...item,
        data: {
          ...item.data,
          entries: item.data.entries.map((value) =>
            value.id === entry.id ? entry : value,
          ),
        },
      })),
    );
  }

  async function savePreviewText() {
    const preview = previewWindow;
    const readOnlyReason = preview
      ? previewTextReadOnlyReason(preview)
      : null;
    if (
      !preview ||
      preview.kind !== "text" ||
      preview.text === null ||
      !isEditableTextEntry(preview.entry) ||
      readOnlyReason ||
      preview.textSaving
    ) {
      return;
    }
    const textSnapshot = preview.text;
    if (!preview.entry.version) {
      setPreviewWindow((current) =>
        current
          ? {
              ...current,
              textSaveError:
                "최신 버전 정보가 없어 저장하지 않았습니다. 새로고침 후 다시 열어 주세요.",
            }
          : current,
      );
      return;
    }
    if (new TextEncoder().encode(textSnapshot).byteLength > TEXT_EDIT_LIMIT) {
      setPreviewWindow((current) =>
        current
          ? {
              ...current,
              textSaveError: "텍스트 파일은 1 MiB까지 저장할 수 있습니다.",
            }
          : current,
      );
      return;
    }
    setPreviewWindow((current) =>
      current?.instanceId === preview.instanceId
        ? {
            ...current,
            textSaving: true,
            textSaveError: null,
            textConflict: false,
          }
        : current,
    );
    const controller = new AbortController();
    previewSaveControllerRef.current = controller;
    try {
      const result = await apiJson<{ entry: Entry }>("/api/drive/content", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          id: preview.entry.id,
          expectedVersion: preview.entry.version,
          mimeType: "text/plain",
          content: textSnapshot,
        }),
      });
      if (previewInstanceRef.current !== preview.instanceId) return;
      replaceEntryEverywhere(result.entry);
      setPreviewWindow((current) =>
        current?.instanceId === preview.instanceId &&
        current.entry.id === preview.entry.id
          ? (() => {
              const saved = reconcileSavedDraft(
                current.text ?? "",
                textSnapshot,
              );
              return {
                ...current,
                entry: result.entry,
                text: saved.draft,
                originalText: saved.original,
                textSaving: false,
                textSaveError: null,
                textConflict: false,
              };
            })()
          : current,
      );
      setNotice("텍스트 파일을 저장했습니다");
    } catch (error) {
      if (
        isAbortError(error) ||
        previewInstanceRef.current !== preview.instanceId
      ) {
        return;
      }
      const conflict = (error as Error & { status?: number }).status === 409;
      setPreviewWindow((current) =>
        current?.instanceId === preview.instanceId &&
        current.entry.id === preview.entry.id
          ? {
              ...current,
              textSaving: false,
              textConflict: conflict,
              textSaveError: conflict
                ? "다른 사람이 먼저 파일을 바꿨습니다. 현재 글은 덮어쓰지 않았습니다."
                : errorMessage(error, "텍스트 파일을 저장하지 못했습니다"),
            }
          : current,
      );
    } finally {
      if (previewSaveControllerRef.current === controller) {
        previewSaveControllerRef.current = null;
      }
    }
  }

  function openPreview(
    entry: Entry,
    keyboardOpener?: { element: HTMLElement; scopeId: string },
  ) {
    const kind = previewKindOf(entry);
    if (!kind) {
      void downloadEntry(entry);
      return;
    }
    previewOpenerRef.current = keyboardOpener
      ? {
          ...keyboardOpener,
          entryId: entry.id,
        }
      : null;
    setContextMenu(null);
    const instanceId = beginPreviewInstance();
    const z = ++zRef.current;
    setPreviewWindow({
      instanceId,
      entry,
      kind,
      x: clamp(logicalViewport.width * 0.14, 8, 400),
      y: clamp(TOP_BAR + 24, TOP_BAR + 6, logicalViewport.height / 3),
      z,
      text: null,
      originalText: null,
      textLoading: kind === "text",
      textError: null,
      textSaveError: null,
      textReadOnlyReason: null,
      textSaving: false,
      textConflict: false,
    });
    if (keyboardOpener) {
      setPreviewFocusRequest((current) => current + 1);
    }
    if (kind === "text") void loadPreviewText(entry, instanceId);
  }

  function closePreview() {
    const opener = previewOpenerRef.current;
    previewOpenerRef.current = null;
    cancelPreviewRequests();
    previewWindowRef.current = null;
    setPreviewWindow(null);
    window.requestAnimationFrame(() => {
      if (opener?.element.isConnected) {
        opener.element.focus();
        return;
      }
      if (opener) findEntryButton(opener.scopeId, opener.entryId)?.focus();
    });
  }

  function discardPreviewForEntry(entryId: string) {
    if (previewWindowRef.current?.entry.id !== entryId) return;
    previewOpenerRef.current = null;
    cancelPreviewRequests();
    previewWindowRef.current = null;
    setPreviewWindow(null);
  }

  function updatePreviewAfterRename(previousId: string, entry: Entry) {
    const current = previewWindowRef.current;
    if (!current || current.entry.id !== previousId) return;
    if (entry.id === previousId) {
      const next = { ...current, entry };
      previewWindowRef.current = next;
      setPreviewWindow((active) =>
        active?.instanceId === current.instanceId
          ? { ...active, entry }
          : active,
      );
      return;
    }

    const shouldReload = current.kind === "text" && current.text === null;
    const instanceId = beginPreviewInstance();
    const next = {
      ...current,
      instanceId,
      entry,
      textLoading: shouldReload,
      textError: shouldReload ? null : current.textError,
      textSaving: false,
      textSaveError: null,
      textConflict: false,
    };
    previewWindowRef.current = next;
    setPreviewWindow((active) =>
      active?.instanceId === current.instanceId
        ? {
            ...active,
            instanceId,
            entry,
            textLoading: shouldReload,
            textError: shouldReload ? null : active.textError,
            textSaving: false,
            textSaveError: null,
            textConflict: false,
          }
        : active,
    );
    if (shouldReload) void loadPreviewText(entry, instanceId);
  }

  function movePreviewWindow(event: ReactPointerEvent<HTMLDivElement>) {
    if (!previewWindow) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const z = ++zRef.current;
    setPreviewWindow((current) => (current ? { ...current, z } : current));
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = previewWindow.x;
    const originY = previewWindow.y;
    const onMove = (next: PointerEvent) => {
      // 창 폭을 JS에서 알 수 없어(폭은 CSS가 정함) 최소 120px는 화면 안에 남긴다.
      const x = clamp(
        originX + logicalPointerDelta(next.clientX - startX, uiScale),
        4,
        Math.max(4, logicalViewport.width - 120),
      );
      const y = clamp(
        originY + logicalPointerDelta(next.clientY - startY, uiScale),
        TOP_BAR + 4,
        Math.max(TOP_BAR + 4, logicalViewport.height - TASK_BAR - 48),
      );
      setPreviewWindow((current) =>
        current ? { ...current, x, y } : current,
      );
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
    window.addEventListener("pointercancel", onEnd, { once: true });
  }

  function activateEntry(
    entry: Entry,
    scopeId: string,
    keyboardOpener?: HTMLElement,
  ) {
    if (movingEntryIdsRef.current.has(entry.id)) return;
    const action = fileActivationAction(entry, downloadFirst);
    if (action === "folder") openFolder(entry, scopeId);
    else if (action === "preview") {
      openPreview(
        entry,
        keyboardOpener ? { element: keyboardOpener, scopeId } : undefined,
      );
    }
    else void downloadEntry(entry);
  }

  function navigateWindow(windowId: string, crumbIndex: number) {
    const item = scopeWindow(windowId);
    if (!item || crumbIndex >= item.path.length - 1) return;
    const nextPath = item.path.slice(0, crumbIndex + 1);
    const folderId = nextPath.at(-1)!.id;
    cancelScopeRequests(windowId);
    setSelected((current) =>
      current?.scopeId === windowId ? null : current,
    );
    setDeskWindows((current) =>
      current.map((value) =>
        value.id === windowId
          ? { ...value, path: nextPath, data: blankFolder() }
          : value,
      ),
    );
    setAddressStates((current) => ({
      ...current,
      [windowId]: {
        value: folderAddress(nextPath),
        busy: false,
        error: null,
      },
    }));
    void loadDeskWindow(windowId, folderId);
  }

  async function navigateAddress(windowId: string) {
    const item = scopeWindow(windowId);
    if (!item) return;
    const request = beginScopedRequest(addressRequestsRef.current, windowId);
    const currentAddress =
      addressStates[windowId]?.value ?? folderAddress(item.path);
    const requestedPath = currentAddress.trim() || "/";
    setAddressStates((current) => ({
      ...current,
      [windowId]: { value: currentAddress, busy: true, error: null },
    }));
    try {
      const result = await apiJson<{ folderId: string; crumbs: Crumb[] }>(
        `/api/drive/path?path=${encodeURIComponent(requestedPath)}`,
        {
          method: "GET",
          cache: "no-store",
          signal: request.controller.signal,
        },
      );
      if (
        addressRequestsRef.current.get(windowId) !== request ||
        !windowsRef.current.some((windowItem) => windowItem.id === windowId)
      ) {
        return;
      }
      const nextPath = result.crumbs.length
        ? result.crumbs
        : [{ id: ROOT_ID, name: "ShareDesk" }];
      cancelScopedRequest(listRequestsRef.current, windowId);
      cancelScopedRequest(layoutRequestsRef.current, windowId);
      cancelLayoutSaves(windowId);
      setSelected((current) =>
        current?.scopeId === windowId ? null : current,
      );
      setDeskWindows((current) =>
        current.map((value) =>
          value.id === windowId
            ? { ...value, path: nextPath, data: blankFolder() }
            : value,
        ),
      );
      setAddressStates((current) => ({
        ...current,
        [windowId]: {
          value: folderAddress(nextPath),
          busy: false,
          error: null,
        },
      }));
      void loadDeskWindow(windowId, result.folderId);
    } catch (error) {
      if (
        isAbortError(error) ||
        addressRequestsRef.current.get(windowId) !== request
      ) {
        return;
      }
      setAddressStates((current) => ({
        ...current,
        [windowId]: {
          value: current[windowId]?.value ?? currentAddress,
          busy: false,
          error: errorMessage(error, "폴더 주소를 찾지 못했습니다"),
        },
      }));
    } finally {
      finishScopedRequest(addressRequestsRef.current, windowId, request);
    }
  }

  async function openFolderNote(item: DeskWindow) {
    const folder = item.path.at(-1);
    if (!folder) return;
    setContextMenu(null);
    const instanceId = beginFolderNoteInstance();
    const controller = new AbortController();
    folderNoteLoadControllerRef.current = controller;
    const x = clamp(
      item.x + 70,
      8,
      Math.max(8, logicalViewport.width - 430),
    );
    const y = clamp(
      item.y + 46,
      TOP_BAR + 6,
      Math.max(TOP_BAR + 6, logicalViewport.height - TASK_BAR - 320),
    );
    setFolderNoteWindow({
      instanceId,
      folderId: folder.id,
      folderName: folder.name,
      path: item.path,
      x,
      y,
      z: ++zRef.current,
      content: "",
      originalContent: "",
      version: null,
      loading: true,
      saving: false,
      error: null,
      conflict: false,
    });
    try {
      const result = await apiJson<{ content: string; version: string | null }>(
        `/api/folder-note?folderId=${encodeURIComponent(folder.id)}`,
        { method: "GET", cache: "no-store", signal: controller.signal },
      );
      if (folderNoteInstanceRef.current !== instanceId) return;
      setFolderNoteWindow((current) =>
        current?.instanceId === instanceId && current.folderId === folder.id
          ? {
              ...current,
              content: result.content,
              originalContent: result.content,
              version: result.version,
              loading: false,
            }
          : current,
      );
    } catch (error) {
      if (
        isAbortError(error) ||
        folderNoteInstanceRef.current !== instanceId
      ) {
        return;
      }
      setFolderNoteWindow((current) =>
        current?.instanceId === instanceId && current.folderId === folder.id
          ? {
              ...current,
              loading: false,
              error: errorMessage(error, "폴더 메모를 불러오지 못했습니다"),
            }
          : current,
      );
    } finally {
      if (folderNoteLoadControllerRef.current === controller) {
        folderNoteLoadControllerRef.current = null;
      }
    }
  }

  async function saveFolderNote() {
    const note = folderNoteWindow;
    if (!note || note.loading || note.saving) return;
    setFolderNoteWindow((current) =>
      current?.instanceId === note.instanceId
        ? { ...current, saving: true, error: null, conflict: false }
        : current,
    );
    const controller = new AbortController();
    folderNoteSaveControllerRef.current = controller;
    try {
      const result = await apiJson<{ content: string; version: string | null }>(
        "/api/folder-note",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            folderId: note.folderId,
            expectedVersion: note.version,
            content: note.content,
          }),
        },
      );
      if (folderNoteInstanceRef.current !== note.instanceId) return;
      setFolderNoteWindow((current) =>
        current?.instanceId === note.instanceId &&
        current.folderId === note.folderId
          ? (() => {
              const saved = reconcileSavedDraft(
                current.content,
                result.content,
              );
              return {
                ...current,
                content: saved.draft,
                originalContent: saved.original,
                version: result.version,
                saving: false,
                conflict: false,
              };
            })()
          : current,
      );
      setNotice("폴더 메모를 저장했습니다");
    } catch (error) {
      if (
        isAbortError(error) ||
        folderNoteInstanceRef.current !== note.instanceId
      ) {
        return;
      }
      const conflict = (error as Error & { status?: number }).status === 409;
      setFolderNoteWindow((current) =>
        current?.instanceId === note.instanceId &&
        current.folderId === note.folderId
          ? {
              ...current,
              saving: false,
              conflict,
              error: conflict
                ? "다른 사람이 먼저 메모를 바꿨습니다. 현재 글은 덮어쓰지 않았습니다."
                : errorMessage(error, "폴더 메모를 저장하지 못했습니다"),
            }
          : current,
      );
    } finally {
      if (folderNoteSaveControllerRef.current === controller) {
        folderNoteSaveControllerRef.current = null;
      }
    }
  }

  function moveFolderNoteWindow(event: ReactPointerEvent<HTMLDivElement>) {
    if (!folderNoteWindow) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = folderNoteWindow.x;
    const originY = folderNoteWindow.y;
    const onMove = (next: PointerEvent) => {
      const x = clamp(
        originX + logicalPointerDelta(next.clientX - startX, uiScale),
        4,
        Math.max(4, logicalViewport.width - 120),
      );
      const y = clamp(
        originY + logicalPointerDelta(next.clientY - startY, uiScale),
        TOP_BAR + 4,
        Math.max(TOP_BAR + 4, logicalViewport.height - TASK_BAR - 48),
      );
      setFolderNoteWindow((current) =>
        current ? { ...current, x, y } : current,
      );
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
    window.addEventListener("pointercancel", onEnd, { once: true });
  }

  function moveWindow(
    event: ReactPointerEvent<HTMLDivElement>,
    item: DeskWindow,
  ) {
    if (item.maximized) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    focusWindow(item.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = item.x;
    const originY = item.y;

    const onMove = (next: PointerEvent) => {
      const x = clamp(
        originX + logicalPointerDelta(next.clientX - startX, uiScale),
        4,
        Math.max(4, logicalViewport.width - item.width - 4),
      );
      const y = clamp(
        originY + logicalPointerDelta(next.clientY - startY, uiScale),
        TOP_BAR + 4,
        Math.max(TOP_BAR + 4, logicalViewport.height - TASK_BAR - 48),
      );
      setDeskWindows((current) =>
        current.map((value) =>
          value.id === item.id ? { ...value, x, y } : value,
        ),
      );
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
    window.addEventListener("pointercancel", onEnd, { once: true });
  }

  function resizeWindow(
    event: ReactPointerEvent<HTMLButtonElement>,
    item: DeskWindow,
  ) {
    if (item.maximized) return;
    event.preventDefault();
    event.stopPropagation();
    focusWindow(item.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const originWidth = item.width;
    const originHeight = item.height;

    const onMove = (next: PointerEvent) => {
      const width = clamp(
        originWidth + logicalPointerDelta(next.clientX - startX, uiScale),
        390,
        Math.max(390, logicalViewport.width - item.x - 6),
      );
      const height = clamp(
        originHeight + logicalPointerDelta(next.clientY - startY, uiScale),
        300,
        Math.max(300, logicalViewport.height - TASK_BAR - item.y - 6),
      );
      setDeskWindows((current) =>
        current.map((value) =>
          value.id === item.id ? { ...value, width, height } : value,
        ),
      );
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
    window.addEventListener("pointercancel", onEnd, { once: true });
  }

  function toggleMaximize(item: DeskWindow) {
    focusWindow(item.id);
    setDeskWindows((current) =>
      current.map((value) => {
        if (value.id !== item.id) return value;
        if (value.maximized && value.restoreRect) {
          return {
            ...value,
            ...value.restoreRect,
            maximized: false,
            restoreRect: undefined,
          };
        }
        return {
          ...value,
          restoreRect: {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
          },
          x: 6,
          y: TOP_BAR + 6,
          width: Math.max(390, logicalViewport.width - 12),
          height: Math.max(
            300,
            logicalViewport.height - TOP_BAR - TASK_BAR - 12,
          ),
          maximized: true,
        };
      }),
    );
  }

  function placementFor(scopeId: string, entry: Entry, index: number) {
    const transient = transientPositions[`${scopeId}:${entry.layoutKey}`];
    if (transient) return transient;
    const stored = scopeData(scopeId)?.positions[entry.layoutKey];
    if (stored) return stored;
    return defaultPlacement(index);
  }

  function planeDimensions(scopeId: string, entries: Entry[]) {
    let width = PLANE_MIN_WIDTH;
    let height = PLANE_MIN_HEIGHT;
    entries.forEach((entry, index) => {
      const placement = placementFor(scopeId, entry, index);
      width = Math.max(width, placement.x + ICON_WIDTH + ICON_INSET_X);
      height = Math.max(height, placement.y + ICON_HEIGHT + ICON_INSET_Y);
    });
    return { width: Math.ceil(width), height: Math.ceil(height) };
  }

  function applySnapshot(
    scopeId: string,
    folderId: string,
    snapshot: LayoutSnapshot,
  ) {
    if (scopeId === ROOT_SCOPE) {
      const identityChanged = Boolean(
        rootDataRef.current.folderIdentity &&
        snapshot.folderIdentity &&
        rootDataRef.current.folderIdentity !== snapshot.folderIdentity,
      );
      invalidateLayoutSavesForIdentityChange(
        scopeId,
        rootDataRef.current.folderIdentity,
        snapshot.folderIdentity,
      );
      if (identityChanged) {
        void loadRoot(true);
        return;
      }
      setRootData((current) =>
        snapshot.folderIdentity === current.folderIdentity &&
        snapshot.revision < current.revision
          ? current
          : { ...current, ...snapshot, layoutError: null },
      );
      return;
    }
    const currentWindow = windowsRef.current.find(
      (item) => item.id === scopeId && item.path.at(-1)?.id === folderId,
    );
    const identityChanged = Boolean(
      currentWindow?.data.folderIdentity &&
      snapshot.folderIdentity &&
      currentWindow.data.folderIdentity !== snapshot.folderIdentity,
    );
    invalidateLayoutSavesForIdentityChange(
      scopeId,
      currentWindow?.data.folderIdentity ?? null,
      snapshot.folderIdentity,
    );
    if (identityChanged) {
      void loadDeskWindow(scopeId, folderId, true);
      return;
    }
    setDeskWindows((current) =>
      current.map((item) =>
        item.id === scopeId && item.path.at(-1)?.id === folderId
          ? {
              ...item,
              data:
                snapshot.folderIdentity === item.data.folderIdentity &&
                snapshot.revision < item.data.revision
                  ? item.data
                  : { ...item.data, ...snapshot, layoutError: null },
            }
          : item,
      ),
    );
  }
  applySnapshotRef.current = applySnapshot;

  function queuePlacement(
    scopeId: string,
    folderId: string,
    folderIdentity: string | null,
    generation: number,
    entry: Entry,
    placement: Placement,
  ) {
    const key = `${scopeId}:${entry.layoutKey}`;
    if (
      !folderIdentity ||
      generation !== layoutSaveGeneration(scopeId) ||
      scopeFolderId(scopeId) !== folderId ||
      scopeData(scopeId)?.folderIdentity !== folderIdentity
    ) {
      setTransientPositions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    const existing = saveQueueRef.current.get(key);
    if (existing) {
      // 이미 저장이 진행 중이다 — 최신 좌표로 덮고, 끝나면 이어서 보낸다.
      existing.next = { x: placement.x, y: placement.y };
      if (!existing.inFlight) void pumpSave(key);
      return;
    }
    saveQueueRef.current.set(key, {
      scopeId,
      folderId,
      folderIdentity,
      generation,
      entry,
      controller: null,
      next: { x: placement.x, y: placement.y },
      inFlight: false,
      baseVersion: placement.version,
    });
    setSavingPositions((current) => new Set(current).add(key));
    void pumpSave(key);
  }

  function isActiveSave(key: string, node: LayoutSaveNode) {
    return (
      saveQueueRef.current.get(key) === node &&
      layoutSaveGeneration(node.scopeId) === node.generation
    );
  }

  function finishSave(key: string, node: LayoutSaveNode) {
    if (saveQueueRef.current.get(key) !== node) return;
    saveQueueRef.current.delete(key);
    savingPositionKeysRef.current.delete(key);
    setSavingPositions((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (draggingKeyRef.current !== key) {
      setTransientPositions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  async function pumpSave(key: string) {
    const node = saveQueueRef.current.get(key);
    if (!node || node.inFlight || !node.next) return;
    const coords = node.next;
    node.next = null;
    node.inFlight = true;
    const controller = new AbortController();
    node.controller = controller;
    try {
      const snapshot = await apiJson<LayoutSnapshot>("/api/desktop/layout", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          folderId: node.folderId,
          folderIdentity: node.folderIdentity,
          updates: [
            {
              entryId: node.entry.id,
              expectedVersion: node.baseVersion,
              x: coords.x,
              y: coords.y,
            },
          ],
        }),
      });
      if (!isActiveSave(key, node)) return;
      node.inFlight = false;
      node.controller = null;
      if (
        snapshot.folderIdentity !== node.folderIdentity ||
        scopeFolderId(node.scopeId) !== node.folderId ||
        scopeData(node.scopeId)?.folderIdentity !== node.folderIdentity
      ) {
        cancelLayoutSaves(node.scopeId);
        return;
      }
      node.baseVersion =
        snapshot.positions[node.entry.layoutKey]?.version ??
        node.baseVersion + 1;
      applySnapshot(node.scopeId, node.folderId, snapshot);
      if (node.next) {
        void pumpSave(key);
        return;
      }
      finishSave(key, node);
    } catch (error) {
      if (!isActiveSave(key, node) || isAbortError(error)) return;
      node.inFlight = false;
      node.controller = null;
      finishSave(key, node);
      if ((error as Error & { status?: number }).status === 409) {
        setNotice("다른 사람이 먼저 옮긴 위치를 반영했습니다");
        if (scopeFolderId(node.scopeId) === node.folderId) {
          if (node.scopeId === ROOT_SCOPE) await loadRoot(true);
          else await loadDeskWindow(node.scopeId, node.folderId, true);
        }
      } else {
        setNotice(errorMessage(error, "아이콘 위치를 저장하지 못했습니다"));
      }
    }
  }

  // 포인터 아래의 이동 대상(폴더 아이콘, 다른 창의 캔버스, 휴지통)을 찾는다.
  // 끌리는 아이콘은 pointer-events: none이라 히트테스트에 걸리지 않는다.
  function findMoveTarget(
    clientX: number,
    clientY: number,
    sourceScopeId: string,
    sourceFolderId: string,
    entry: Entry,
  ): InternalDropTarget | null {
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) return null;
    if (element.closest("[data-drop-trash]")) {
      return { kind: "trash", highlightKey: "trash" };
    }
    const icon = element.closest<HTMLElement>("[data-drop-folder]");
    if (icon?.dataset.dropFolder && icon.dataset.dropScope) {
      const folderId = icon.dataset.dropFolder;
        if (folderId !== entry.id) {
          return {
            kind: "folder",
            folderId,
          highlightKey: `icon:${icon.dataset.dropScope}:${folderId}`,
        };
      }
      return null;
    }
    const canvas = element.closest<HTMLElement>("[data-canvas-scope]");
    const canvasScope = canvas?.dataset.canvasScope;
    const canvasFolder = canvas?.dataset.canvasFolder;
    if (
      canvasScope &&
      canvasFolder &&
      canvasScope !== sourceScopeId &&
      canvasFolder !== sourceFolderId &&
      canvasFolder !== entry.id
    ) {
        return {
          kind: "folder",
          folderId: canvasFolder,
          highlightKey: `canvas:${canvasScope}`,
        };
    }
    return null;
  }

  async function moveEntry(
    sourceScopeId: string,
    entry: Entry,
    targetFolderId: string,
  ) {
    const transientKey = `${sourceScopeId}:${entry.layoutKey}`;
    if (!entry.version) {
      setTransientPositions((current) => {
        const next = { ...current };
        delete next[transientKey];
        return next;
      });
      setNotice("항목 정보가 오래되어 옮기지 못했습니다 — 잠시 후 다시 시도해 주세요");
      await refreshScope(sourceScopeId, true);
      return;
    }
    if (movingEntryIdsRef.current.has(entry.id)) return;
    const sourceFolderId = scopeFolderId(sourceScopeId);
    const affectedFolderIds = [...new Set([sourceFolderId, targetFolderId])];
    affectedFolderIds.forEach((folderId) => {
      markFolderMutation(folderId);
      pendingFolderMutationsRef.current.set(
        folderId,
        (pendingFolderMutationsRef.current.get(folderId) ?? 0) + 1,
      );
    });
    const finishFolderMutations = () => {
      const foldersToRefresh: string[] = [];
      affectedFolderIds.forEach((folderId) => {
        markFolderMutation(folderId);
        const remaining =
          (pendingFolderMutationsRef.current.get(folderId) ?? 1) - 1;
        if (remaining > 0) {
          pendingFolderMutationsRef.current.set(folderId, remaining);
        } else {
          pendingFolderMutationsRef.current.delete(folderId);
          notifyFolderIdle(folderId);
          if (foldersNeedingRefreshRef.current.delete(folderId)) {
            foldersToRefresh.push(folderId);
          }
        }
      });
      return foldersToRefresh;
    };
    cancelFolderListRequests(sourceFolderId);
    cancelFolderListRequests(targetFolderId);
    movingEntryIdsRef.current.add(entry.id);
    setSelected((current) =>
      current?.scopeId === sourceScopeId && current.layoutKey === entry.layoutKey
        ? null
        : current,
    );
    setContextMenu(null);
    setTransientPositions((current) => {
      const next = { ...current };
      delete next[transientKey];
      return next;
    });
    removeFolderEntry(sourceFolderId, entry.id);
    upsertFolderEntry(targetFolderId, entry);
    try {
      const body = await apiJson<{ entry: Entry }>("/api/drive/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          targetFolderId,
          expectedVersion: entry.version,
        }),
      });
      cancelFolderListRequests(sourceFolderId);
      cancelFolderListRequests(targetFolderId);
      if (entry.isFolder) {
        closeWindowsContainingFolder(entry.id);
      } else if (body.entry.id !== entry.id) {
        updatePreviewAfterRename(entry.id, body.entry);
        if (previewOpenerRef.current?.entryId === entry.id) {
          previewOpenerRef.current = null;
        }
      }
      removeFolderEntry(sourceFolderId, entry.id);
      movingEntryIdsRef.current.delete(entry.id);
      updateFolderEntries(targetFolderId, (entries) =>
        sortedEntries(confirmedMoveEntries(entries, entry.id, body.entry)),
      );
      const foldersToRefresh = finishFolderMutations();
      setNotice(`‘${entry.name}’ 항목을 옮겼습니다`);
      if (foldersToRefresh.length > 0) {
        void refreshFolders(foldersToRefresh);
      }
    } catch (error) {
      const failureKind = classifyMoveFailure(error);
      if (failureKind === "definitive") {
        movingEntryIdsRef.current.delete(entry.id);
        removeFolderEntry(targetFolderId, entry.id);
        upsertFolderEntry(sourceFolderId, entry);
      } else {
        if (entry.isFolder) {
          closeWindowsContainingFolder(entry.id);
        } else {
          discardPreviewForEntry(entry.id);
        }
        setNotice(`‘${entry.name}’ 항목의 실제 위치를 확인하고 있습니다`);
      }
      affectedFolderIds.forEach((folderId) =>
        foldersNeedingRefreshRef.current.add(folderId),
      );
      const foldersToRefresh = finishFolderMutations();
      if (failureKind === "definitive") {
        setNotice(errorMessage(error, "옮기지 못했습니다"));
        await refreshFolders(foldersToRefresh);
        return;
      }

      let refreshed = false;
      try {
        while (true) {
          await waitForFoldersIdle(affectedFolderIds);
          const startedVersions = folderMutationSnapshot(affectedFolderIds);
          refreshed = await refreshFolders(affectedFolderIds);
          if (
            refreshed ||
            !shouldRetryFolderReconciliation(
              affectedFolderIds,
              pendingFolderMutationsRef.current,
              startedVersions,
              folderMutationVersionsRef.current,
            )
          ) {
            break;
          }
        }
      } finally {
        movingEntryIdsRef.current.delete(entry.id);
      }
      setNotice(
        refreshed
          ? `‘${entry.name}’ 항목의 원본과 대상 폴더를 다시 불러왔습니다`
          : `‘${entry.name}’ 항목의 이동 결과를 확인하지 못했습니다 — 새로고침해 주세요`,
      );
    }
  }

  async function trashDraggedEntry(sourceScopeId: string, entry: Entry) {
    if (movingEntryIdsRef.current.has(entry.id)) return;
    const sourceFolderId = scopeFolderId(sourceScopeId);
    const transientKey = `${sourceScopeId}:${entry.layoutKey}`;
    markFolderMutation(sourceFolderId);
    pendingFolderMutationsRef.current.set(
      sourceFolderId,
      (pendingFolderMutationsRef.current.get(sourceFolderId) ?? 0) + 1,
    );
    cancelFolderListRequests(sourceFolderId);
    movingEntryIdsRef.current.add(entry.id);
    setSelected((current) =>
      current?.scopeId === sourceScopeId && current.layoutKey === entry.layoutKey
        ? null
        : current,
    );
    setContextMenu(null);
    setTransientPositions((current) => {
      const next = { ...current };
      delete next[transientKey];
      return next;
    });
    removeFolderEntry(sourceFolderId, entry.id);

    try {
      await apiJson("/api/drive/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      if (entry.isFolder) {
        closeWindowsContainingFolder(entry.id);
      } else {
        discardPreviewForEntry(entry.id);
      }
      setNotice(`‘${entry.name}’을 휴지통에 넣었습니다`);
      if (trashWindow) {
        setTrashWindow((current) =>
          current ? { ...current, loading: true } : current,
        );
        void loadTrash();
      }
    } catch (error) {
      if (classifyMoveFailure(error) === "definitive") {
        upsertFolderEntry(sourceFolderId, entry);
      } else if (entry.isFolder) {
        closeWindowsContainingFolder(entry.id);
      } else {
        discardPreviewForEntry(entry.id);
      }
      setNotice(errorMessage(error, "휴지통에 넣지 못했습니다"));
      foldersNeedingRefreshRef.current.add(sourceFolderId);
    } finally {
      movingEntryIdsRef.current.delete(entry.id);
      markFolderMutation(sourceFolderId);
      const remaining =
        (pendingFolderMutationsRef.current.get(sourceFolderId) ?? 1) - 1;
      if (remaining > 0) {
        pendingFolderMutationsRef.current.set(sourceFolderId, remaining);
        foldersNeedingRefreshRef.current.add(sourceFolderId);
      } else {
        pendingFolderMutationsRef.current.delete(sourceFolderId);
        notifyFolderIdle(sourceFolderId);
        foldersNeedingRefreshRef.current.delete(sourceFolderId);
        await refreshScope(sourceScopeId, true);
      }
    }
  }

  async function loadTrash() {
    try {
      const body = await apiJson<{ entries: TrashEntry[] }>(
        "/api/drive/trash",
        { method: "GET" },
      );
      setTrashWindow((current) =>
        current
          ? { ...current, entries: body.entries, loading: false, error: null }
          : current,
      );
    } catch (error) {
      setTrashWindow((current) =>
        current
          ? {
              ...current,
              loading: false,
              error: errorMessage(error, "휴지통을 불러오지 못했습니다"),
            }
          : current,
      );
    }
  }

  function openTrash() {
    setContextMenu(null);
    const z = ++zRef.current;
    setTrashWindow((current) => {
      if (current) return { ...current, z };
      const width = Math.min(
        480,
        Math.max(320, logicalViewport.width - 32),
      );
      return {
        x: clamp(
          (logicalViewport.width - width) / 2 + 60,
          8,
          Math.max(8, logicalViewport.width - width - 8),
        ),
        y: clamp(
          TOP_BAR + 52,
          TOP_BAR + 6,
          logicalViewport.height / 2,
        ),
        z,
        entries: [],
        loading: true,
        error: null,
        busyId: null,
        confirmId: null,
      };
    });
    void loadTrash();
  }

  async function refreshEverything() {
    const jobs: Promise<boolean>[] = [loadRoot(true)];
    for (const item of windowsRef.current) {
      const folderId = item.path.at(-1)?.id;
      if (folderId && !item.minimized) {
        jobs.push(loadDeskWindow(item.id, folderId, true));
      }
    }
    await Promise.all(jobs);
  }

  async function trashAction(
    action: "restore" | "purge" | "empty",
    id?: string,
    version?: string,
  ) {
    const busyId = id ?? "__empty__";
    setTrashWindow((current) =>
      current ? { ...current, busyId, confirmId: null } : current,
    );
    try {
      const result = await apiJson<{ warning?: string | null }>(
        "/api/drive/trash",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            id,
            version,
            targets:
              action === "empty"
                ? (trashWindow?.entries ?? []).map((entry) => ({
                    id: entry.id,
                    version: entry.version,
                  }))
                : undefined,
          }),
        },
      );
      setNotice(
        result.warning ??
          (action === "restore"
            ? "복원했습니다"
            : action === "purge"
              ? "완전히 삭제했습니다"
              : "휴지통을 비웠습니다"),
      );
      if (action === "restore") await refreshEverything();
    } catch (error) {
      setNotice(errorMessage(error, "휴지통 작업에 실패했습니다"));
    } finally {
      setTrashWindow((current) =>
        current ? { ...current, busyId: null, loading: true } : current,
      );
      await loadTrash();
    }
  }

  function moveTrashWindow(event: ReactPointerEvent<HTMLDivElement>) {
    if (!trashWindow) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const z = ++zRef.current;
    setTrashWindow((current) => (current ? { ...current, z } : current));
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = trashWindow.x;
    const originY = trashWindow.y;
    const onMove = (next: PointerEvent) => {
      // 창 폭을 JS에서 알 수 없어(폭은 CSS가 정함) 최소 120px는 화면 안에 남긴다.
      const x = clamp(
        originX + logicalPointerDelta(next.clientX - startX, uiScale),
        4,
        Math.max(4, logicalViewport.width - 120),
      );
      const y = clamp(
        originY + logicalPointerDelta(next.clientY - startY, uiScale),
        TOP_BAR + 4,
        Math.max(TOP_BAR + 4, logicalViewport.height - TASK_BAR - 48),
      );
      setTrashWindow((current) => (current ? { ...current, x, y } : current));
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
    window.addEventListener("pointercancel", onEnd, { once: true });
  }

  function startIconDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    scopeId: string,
    entry: Entry,
    index: number,
  ) {
    if (event.button !== 0) return;
    const transientKey = `${scopeId}:${entry.layoutKey}`;
    if (
      savingPositionKeysRef.current.has(transientKey) ||
      movingEntryIdsRef.current.has(entry.id)
    ) {
      return;
    }
    const canvas = scopeCanvas(scopeId);
    if (!canvas) return;
    const startPlacement = placementFor(scopeId, entry, index);
    const folderId = scopeFolderId(scopeId);
    const folderIdentity = scopeData(scopeId)?.folderIdentity ?? null;
    const saveGeneration = layoutSaveGeneration(scopeId);
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const startLeft = startPlacement.x;
    const startTop = startPlacement.y;
    const dragThreshold =
      event.pointerType === "touch" ||
      window.matchMedia("(pointer: coarse)").matches
        ? 12
        : 5;
    let moved = false;
    let lastClientX = startX;
    let lastClientY = startY;
    let moveTarget: InternalDropTarget | null = null;
    event.preventDefault();

    const onMove = (next: PointerEvent) => {
      if (!isDragPointer(pointerId, next.pointerId)) return;
      lastClientX = next.clientX;
      lastClientY = next.clientY;
      const dx = next.clientX - startX;
      const dy = next.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < dragThreshold) return;
      moved = true;
      setDraggingKey(transientKey);
      draggingKeyRef.current = transientKey;
      setDragGhost({ entry, clientX: next.clientX, clientY: next.clientY });
      moveTarget = findMoveTarget(
        next.clientX,
        next.clientY,
        scopeId,
        folderId,
        entry,
      );
      setDropTargetKey(moveTarget?.highlightKey ?? null);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      setDraggingKey(null);
      draggingKeyRef.current = null;
      setDropTargetKey(null);
      setDragGhost(null);
    };
    const onEnd = (next: PointerEvent) => {
      const action = dragTerminalAction(
        "pointerup",
        isDragPointer(pointerId, next.pointerId),
        moved,
      );
      if (action === "ignore") return;
      cleanup();
      if (action !== "commit") return;
      suppressedClickRef.current.add(transientKey);
      window.setTimeout(
        () => suppressedClickRef.current.delete(transientKey),
        0,
      );
      if (moveTarget) {
        if (moveTarget.kind === "trash") {
          void trashDraggedEntry(scopeId, entry);
        } else {
          void moveEntry(scopeId, entry, moveTarget.folderId);
        }
        return;
      }
      const x = clamp(
        startLeft + logicalPointerDelta(lastClientX - startX, uiScale),
        0,
        MAX_LOGICAL_COORDINATE,
      );
      const y = clamp(
        startTop + logicalPointerDelta(lastClientY - startY, uiScale),
        0,
        MAX_LOGICAL_COORDINATE,
      );
      queuePlacement(scopeId, folderId, folderIdentity, saveGeneration, entry, {
        ...startPlacement,
        x,
        y,
      });
    };
    const onCancel = (next: PointerEvent) => {
      const action = dragTerminalAction(
        "pointercancel",
        isDragPointer(pointerId, next.pointerId),
        moved,
      );
      if (action === "ignore") return;
      cleanup();
      if (action !== "discard") return;
      setTransientPositions((current) => {
        const updated = { ...current };
        delete updated[transientKey];
        return updated;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onCancel);
  }

  function openContextMenu(
    event: React.MouseEvent,
    scopeId: string,
    entry?: Entry,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (entry && movingEntryIdsRef.current.has(entry.id)) return;
    if (scopeData(scopeId)?.loading) return;
    const width = 210;
    // 항목 메뉴는 미리보기/다운로드 분리, 바탕화면 메뉴는 배경 4종이 추가됐다.
    const height = entry
      ? entryContextMenuHeight(scopeId)
      : scopeId === ROOT_SCOPE
        ? 330
        : 194;
    const target = event.target as HTMLElement;
    const activeElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setContextMenu({
      x: Math.max(
        8,
        Math.min(
          logicalClientCoordinate(event.clientX, uiScale),
          logicalViewport.width - width - 8,
        ),
      ),
      y: Math.max(
        8,
        Math.min(
          logicalClientCoordinate(event.clientY, uiScale),
          logicalViewport.height - height - 8,
        ),
      ),
      scopeId,
      entry,
      opener:
        target.closest<HTMLElement>("button, a, [tabindex]") ?? activeElement,
    });
    if (entry) setSelected({ scopeId, layoutKey: entry.layoutKey });
  }

  function openKeyboardMenu(
    target: HTMLElement,
    scopeId: string,
    entry: Entry,
  ) {
    const rect = target.getBoundingClientRect();
    const menuHeight = entryContextMenuHeight(scopeId);
    setContextMenu({
      x: Math.min(
        logicalClientCoordinate(rect.left + 24, uiScale),
        logicalViewport.width - 218,
      ),
      y: Math.max(
        8,
        Math.min(
          logicalClientCoordinate(rect.top + 32, uiScale),
          logicalViewport.height - menuHeight - 8,
        ),
      ),
      scopeId,
      entry,
      opener: target,
    });
    setSelected({ scopeId, layoutKey: entry.layoutKey });
  }

  function openShareDialog(entry: Entry) {
    shareDialogOpenerRef.current = contextMenu?.opener ?? null;
    setContextMenu(null);
    setShareEntry(entry);
  }

  function closeShareDialog() {
    const opener = shareDialogOpenerRef.current;
    shareDialogOpenerRef.current = null;
    setShareEntry(null);
    window.requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    });
  }

  function openDialog(nextDialog: DialogState, opener?: HTMLElement | null) {
    const activeElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogOpenerRef.current = opener ?? activeElement;
    setDialog(nextDialog);
  }

  function closeDialog() {
    setDialog(null);
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!dialogBusy) closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        DIALOG_FOCUSABLE_SELECTOR,
      ),
    );
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (
      event.shiftKey &&
      (active === first || !event.currentTarget.contains(active))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !event.currentTarget.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleContextMenuKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      const opener = contextMenu?.opener;
      setContextMenu(null);
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ),
    );
    if (!items.length) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    }
    if (event.key === "ArrowUp") {
      nextIndex =
        currentIndex < 0
          ? items.length - 1
          : (currentIndex - 1 + items.length) % items.length;
    }
    items[nextIndex]?.focus();
  }

  function requestUpload(scopeId: string) {
    uploadScopeRef.current = scopeId;
    setContextMenu(null);
    fileInputRef.current?.click();
  }

  async function uploadOne(file: File, folderId: string) {
    const mimeType = file.type || "application/octet-stream";
    const transferId = crypto.randomUUID();
    const updateTransfer = (transferred: number, total: number) => {
      reportTransferProgress({
        id: transferId,
        kind: "upload",
        name: file.name,
        transferred,
        total,
      });
    };
    updateTransfer(0, file.size);
    try {
      const session = await apiJson<UploadSession>("/api/drive/upload-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: folderId,
          name: file.name,
          mimeType,
          size: file.size,
        }),
      });
      if (session.mode === "direct") {
        const response = await uploadWithProgress(
          session.url,
          "PUT",
          file,
          null,
          updateTransfer,
        );
        if (response.status < 200 || response.status >= 300) {
          throw new Error("드라이브 업로드에 실패했습니다");
        }
        const body = JSON.parse(response.responseText || "null") as {
          id?: string;
        } | null;
        return body?.id ?? null;
      }
      const response = await uploadWithProgress(
        `/api/drive/upload?parentId=${encodeURIComponent(folderId)}&name=${encodeURIComponent(file.name)}`,
        "POST",
        file,
        mimeType,
        updateTransfer,
      );
      if (response.status === 401) {
        router.replace("/");
        throw new Error("세션이 만료되었습니다");
      }
      const body = JSON.parse(response.responseText || "null") as {
        error?: string;
        entry?: Entry;
      } | null;
      if (response.status < 200 || response.status >= 300) {
        throw new Error(body?.error ?? "업로드에 실패했습니다");
      }
      return body?.entry?.id ?? null;
    } finally {
      reportTransferProgress(null, transferId);
    }
  }

  async function uploadFiles(files: FileList | File[], scopeId: string) {
    const list = Array.from(files);
    if (!list.length) return;
    const folderId = scopeFolderId(scopeId);
    const failed: string[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index];
      try {
        await uploadOne(file, folderId);
      } catch (error) {
        failed.push(`${file.name}: ${errorMessage(error, "실패")}`);
      }
    }
    setNotice(
      failed.length
        ? `일부 파일을 올리지 못했습니다 · ${failed.join(" / ")}`
        : `${list.length}개 파일을 올렸습니다`,
    );
    await refreshScope(scopeId);
  }

  async function createNotepad(scopeId: string) {
    const data = scopeData(scopeId);
    if (!data || data.loading) return;
    const name = nextNotepadName(data.entries.map((entry) => entry.name));
    const file = new File([""], name, { type: "text/plain" });
    const folderId = scopeFolderId(scopeId);
    setContextMenu(null);
    let uploadedId: string | null;
    try {
      uploadedId = await uploadOne(file, folderId);
    } catch (error) {
      setNotice(errorMessage(error, "새 메모장을 만들지 못했습니다"));
      return;
    }
    try {
      const fresh = await fetchFolder(folderId, new AbortController().signal);
      const entry = fresh.entries.find((value) =>
        uploadedId ? value.id === uploadedId : value.name === name,
      );
      if (!entry) {
        setNotice(
          `‘${name}’ 메모장은 만들었지만 바로 열지 못했습니다 — 새로고침해 주세요`,
        );
        void refreshScope(scopeId, true);
        return;
      }
      upsertFolderEntry(folderId, entry);
      openPreview(entry);
      setNotice(`‘${name}’ 메모장을 만들었습니다`);
    } catch {
      setNotice(
        `‘${name}’ 메모장은 만들었지만 목록을 새로고치지 못했습니다 — 새로고침해 주세요`,
      );
      void refreshScope(scopeId, true);
    }
  }

  async function submitDialog() {
    if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    let deleteFocus:
      | {
          scopeId: string;
          deletedEntryId: string;
          candidateEntryIds: string[];
        }
      | null = null;
    try {
      const folderId = scopeFolderId(dialog.scopeId);
      if (dialog.kind === "create") {
        await apiJson("/api/drive/mkdir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentId: folderId, name: dialog.value }),
        });
        setNotice(`‘${dialog.value.trim()}’ 폴더를 만들었습니다`);
      } else if (dialog.kind === "rename") {
        const result = await apiJson<{ entry: Entry }>("/api/drive/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: dialog.entry.id, name: dialog.value }),
        });
        const renamedName = result.entry?.name ?? dialog.value.trim();
        if (dialog.entry.isFolder) {
          if (result.entry.id !== dialog.entry.id) {
            closeWindowsContainingFolder(dialog.entry.id);
          } else {
            updateRenamedFolder(dialog.entry.id, {
              id: result.entry.id,
              name: renamedName,
            });
          }
        }
        if (!dialog.entry.isFolder) {
          updatePreviewAfterRename(dialog.entry.id, result.entry);
          if (
            result.entry.id !== dialog.entry.id &&
            previewOpenerRef.current?.entryId === dialog.entry.id
          ) {
            previewOpenerRef.current = null;
          }
        }
        setNotice("이름을 바꿨습니다");
      } else {
        const entries = scopeData(dialog.scopeId)?.entries ?? [];
        const deletedIndex = entries.findIndex(
          (entry) => entry.id === dialog.entry.id,
        );
        deleteFocus = {
          scopeId: dialog.scopeId,
          deletedEntryId: dialog.entry.id,
          candidateEntryIds:
            deletedIndex < 0
              ? []
              : [entries[deletedIndex + 1]?.id, entries[deletedIndex - 1]?.id].filter(
                  (id): id is string => !!id,
                ),
        };
        await apiJson("/api/drive/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: dialog.entry.id }),
        });
        if (dialog.entry.isFolder) {
          closeWindowsContainingFolder(dialog.entry.id);
        }
        setNotice(`‘${dialog.entry.name}’을 삭제했습니다`);
        // 삭제 성공 뒤에는 곧 사라질 아이콘으로 포커스를 되돌리지 않는다.
        dialogOpenerRef.current = null;
        if (trashWindow) {
          setTrashWindow((current) =>
            current ? { ...current, loading: true } : current,
          );
          void loadTrash();
        }
      }
      const scopeId = dialog.scopeId;
      closeDialog();
      setContextMenu(null);
      setSelected(null);
      await refreshScope(scopeId);
      if (deleteFocus) {
        focusAfterDelete(
          deleteFocus.scopeId,
          deleteFocus.deletedEntryId,
          deleteFocus.candidateEntryIds,
        );
      }
    } catch (error) {
      if (
        dialog.kind === "rename" &&
        classifyMoveFailure(error) === "uncertain"
      ) {
        if (dialog.entry.isFolder) {
          closeWindowsContainingFolder(dialog.entry.id);
        } else {
          discardPreviewForEntry(dialog.entry.id);
        }
        await refreshScope(dialog.scopeId, true);
      }
      setNotice(errorMessage(error, "작업을 마치지 못했습니다"));
    } finally {
      setDialogBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/presence", {
      method: "DELETE",
      cache: "no-store",
      keepalive: true,
    }).catch(() => undefined);
    await fetch("/api/auth", { method: "DELETE" });
    router.replace("/");
    router.refresh();
  }

  function renderCanvas(scopeId: string) {
    const data = scopeData(scopeId) ?? blankFolder(false);
    const isRoot = scopeId === ROOT_SCOPE;
    const setCanvasRef = (element: HTMLDivElement | null) => {
      if (isRoot) return;
      if (element) windowCanvasRefs.current.set(scopeId, element);
      else windowCanvasRefs.current.delete(scopeId);
    };
    const dimensions = planeDimensions(scopeId, data.entries);

    return (
      <div
        className={`${styles.iconCanvas} ${
          isRoot ? styles.rootCanvas : styles.windowCanvas
        } ${dragOverScope === scopeId ? styles.dropActive : ""} ${
          dropTargetKey === `canvas:${scopeId}` ? styles.moveTargetCanvas : ""
        }`}
        data-canvas-scope={scopeId}
        data-canvas-folder={scopeFolderId(scopeId)}
        onClick={() => {
          setSelected(null);
          setContextMenu(null);
        }}
        onContextMenu={(event) => openContextMenu(event, scopeId)}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragOverScope(scopeId);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragOverScope(null);
          }
        }}
        onDrop={(event) => {
          if (data.loading || !event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragOverScope(null);
          void uploadFiles(event.dataTransfer.files, scopeId);
        }}
        aria-label={isRoot ? "공유 바탕화면" : "폴더 내용"}
        aria-busy={data.loading}
      >
        <div
          ref={isRoot ? rootCanvasRef : setCanvasRef}
          className={styles.iconPlane}
          tabIndex={-1}
          style={{ width: dimensions.width, height: dimensions.height }}
        >
          {data.entries.map((entry, index) => {
          const position = placementFor(scopeId, entry, index);
          const key = `${scopeId}:${entry.layoutKey}`;
          const moving = movingEntryIdsRef.current.has(entry.id);
          const active =
            selected?.scopeId === scopeId &&
            selected.layoutKey === entry.layoutKey;
          const style = {
            left: position.x,
            top: position.y,
          } as CSSProperties;
          return (
            <div
              key={entry.layoutKey}
              className={`${styles.desktopIcon} ${
                active ? styles.iconSelected : ""
              } ${
                savingPositions.has(key) || moving ? styles.iconSaving : ""
              } ${draggingKey === key ? styles.iconDragging : ""} ${
                entry.isFolder &&
                dropTargetKey === `icon:${scopeId}:${entry.id}`
                  ? styles.dropTargetIcon
                  : ""
              }`}
              style={style}
              data-drop-folder={entry.isFolder ? entry.id : undefined}
              data-drop-scope={entry.isFolder ? scopeId : undefined}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => openContextMenu(event, scopeId, entry)}
            >
              <button
                type="button"
                className={styles.iconMain}
                title={entry.name}
                aria-label={`${entry.isFolder ? "폴더" : "파일"} ${entry.name}`}
                aria-pressed={active}
                aria-busy={savingPositions.has(key) || moving}
                data-entry-id={entry.id}
                disabled={moving}
                onPointerDown={(event) =>
                  startIconDrag(event, scopeId, entry, index)
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressedClickRef.current.has(key)) return;
                  if (window.matchMedia("(pointer: coarse)").matches) {
                    activateEntry(entry, scopeId);
                  } else {
                    setSelected({ scopeId, layoutKey: entry.layoutKey });
                    setContextMenu(null);
                  }
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (!suppressedClickRef.current.has(key)) {
                    activateEntry(entry, scopeId);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    activateEntry(entry, scopeId, event.currentTarget);
                  }
                  if (event.key === "F2") {
                    event.preventDefault();
                    openDialog(
                      {
                        kind: "rename",
                        scopeId,
                        entry,
                        value: entry.name,
                      },
                      event.currentTarget,
                    );
                  }
                  if (event.key === "Delete") {
                    event.preventDefault();
                    openDialog(
                      { kind: "delete", scopeId, entry },
                      event.currentTarget,
                    );
                  }
                  if (
                    event.key === "ContextMenu" ||
                    (event.shiftKey && event.key === "F10")
                  ) {
                    event.preventDefault();
                    openKeyboardMenu(event.currentTarget, scopeId, entry);
                  }
                }}
              >
                <PixelFileIcon entry={entry} size={54} />
                <span className={styles.iconName}>{entry.name}</span>
              </button>
              <button
                type="button"
                className={styles.iconMore}
                aria-label={`${entry.name} 메뉴`}
                disabled={moving}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => openContextMenu(event, scopeId, entry)}
              >
                ···
              </button>
            </div>
          );
          })}
        </div>

        {data.loading && data.entries.length === 0 && (
          <div className={styles.canvasMessage} role="status">
            <span className={styles.loadingPixels} aria-hidden="true">
              ▪ ▪ ▫
            </span>
            <strong>{isRoot ? "책상 정리 중" : "폴더 여는 중"}</strong>
            <span>잠시만 기다려 주세요</span>
          </div>
        )}

        {!data.loading && data.error && (
          <div className={styles.canvasMessage} role="alert">
            <span className={styles.brokenPaper} aria-hidden="true" />
            <strong>불러오지 못했어요</strong>
            <span>{data.error}</span>
            <button type="button" onClick={() => void refreshScope(scopeId)}>
              다시 시도
            </button>
          </div>
        )}

        {data.layoutError && (
          <div className={styles.layoutWarning} role="status">
            공유 배치를 불러오지 못해 자동으로 정렬했습니다
          </div>
        )}

        {dragOverScope === scopeId && (
          <div className={styles.dropOverlay}>
            <strong>여기에 놓아 주세요</strong>
            <span>{isRoot ? "공유 바탕화면" : "이 폴더"}에 업로드합니다</span>
          </div>
        )}
      </div>
    );
  }

  const activeSelection = selected
    ? scopeData(selected.scopeId)?.entries.find(
        (entry) => entry.layoutKey === selected.layoutKey,
      )
    : undefined;
  const previewReadOnlyReason = previewWindow
    ? previewTextReadOnlyReason(previewWindow)
    : null;

  return (
    <main
      className={styles.viewport}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className={styles.desktop}
        data-testid="scaled-desktop-stage"
        data-ui-scale={uiScale.toFixed(4)}
        style={{
          width: logicalViewport.width,
          height: logicalViewport.height,
          transform: `scale(${uiScale})`,
        }}
      >
      <div
        className={styles.wallpaper}
        style={{
          backgroundImage: `url(${
            WALLPAPERS.find((w) => w.id === wallpaperId)?.src ??
            WALLPAPERS[0].src
          })`,
        }}
        aria-hidden="true"
      />

      <header className={styles.topBar}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <strong>ShareDesk</strong>
          <span className={styles.desktopLabel}>공유 바탕화면</span>
        </div>
        <div className={styles.presenceArea}>
          <button
            type="button"
            className={styles.connection}
            aria-expanded={presence.open}
            aria-controls="presence-panel"
            onClick={() => {
              setPresence((current) => ({ ...current, open: !current.open }));
              if (!presence.open) void readPresence();
            }}
          >
            <span
              className={`${styles.liveDot} ${
                presence.error ? styles.liveDotError : ""
              }`}
              aria-hidden="true"
            />
            <span>
              {presence.error
                ? "접속 확인 실패"
                : presence.count > 0
                  ? `함께 쓰는 중 · ${presence.count}명`
                  : presence.loading
                    ? "접속 인원 확인 중"
                    : "현재 접속자 없음"}
            </span>
          </button>
          {presence.open && (
            <div
              id="presence-panel"
              className={styles.presencePanel}
              role="status"
            >
              <strong>현재 접속 인원</strong>
              {presence.error ? (
                <>
                  <p>{presence.error}</p>
                  <button type="button" onClick={() => void refreshPresence()}>
                    다시 확인
                  </button>
                </>
              ) : presence.members.length > 0 ? (
                <ul>
                  {presence.members.map((member, index) => (
                    <li
                      className={styles.presenceMember}
                      key={`${member.name}:${index}`}
                    >
                      <div className={styles.memberHeading}>
                        <span className={styles.memberDot} aria-hidden="true" />
                        <span title={member.name}>{member.name}</span>
                        {member.isSelf && <em>나</em>}
                      </div>
                      {member.transfers.length > 0 && (
                        <div className={styles.memberTransfers}>
                          <span>
                            올리는 중 {member.transfers.filter((item) => item.kind === "upload").length}개
                            {" · "}
                            받는 중 {member.transfers.filter((item) => item.kind === "download").length}개
                          </span>
                          {member.transfers.map((transfer) => (
                            <div className={styles.transferRow} key={transfer.id}>
                              <span aria-hidden="true">
                                {transfer.kind === "upload" ? "↑" : "↓"}
                              </span>
                              <span title={transfer.name}>{transfer.name}</span>
                              <span>{transferProgressText(transfer)}</span>
                              {transfer.total !== null && transfer.total > 0 && (
                                <progress
                                  value={transfer.transferred}
                                  max={transfer.total}
                                  aria-label={`${transfer.name} 진행률`}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  {presence.loading
                    ? "확인하고 있습니다"
                    : "접속 중인 사람이 없습니다"}
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      {renderCanvas(ROOT_SCOPE)}

      {deskWindows.map((item) => {
        if (item.minimized) return null;
        const currentFolder = item.path.at(-1);
        const active = item.z === Math.max(...deskWindows.map((value) => value.z));
        const selectedEntry =
          selected?.scopeId === item.id
            ? item.data.entries.find(
                (entry) => entry.layoutKey === selected.layoutKey,
              )
            : undefined;
        const addressState = addressStates[item.id] ?? {
          value: folderAddress(item.path),
          busy: false,
          error: null,
        };
        return (
          <section
            key={item.id}
            className={`${styles.folderWindow} ${
              active ? styles.activeWindow : ""
            } ${item.maximized ? styles.maximizedWindow : ""}`}
            style={{
              left: item.x,
              top: item.y,
              width: item.width,
              height: item.height,
              zIndex: item.z,
            }}
            aria-label={`${currentFolder?.name ?? "폴더"} 창`}
            onPointerDown={() => focusWindow(item.id)}
          >
            <div
              className={styles.windowTitlebar}
              onPointerDown={(event) => moveWindow(event, item)}
              onDoubleClick={(event) => {
                if (!(event.target as HTMLElement).closest("button")) {
                  toggleMaximize(item);
                }
              }}
            >
              <span className={styles.miniFolder} aria-hidden="true" />
              <strong>{currentFolder?.name ?? "폴더"}</strong>
              {item.data.loading && <span className={styles.titleLoading}>여는 중</span>}
              <div className={styles.windowControls}>
                <button
                  type="button"
                  aria-label="최소화"
                  onClick={() =>
                    setDeskWindows((current) =>
                      current.map((value) =>
                        value.id === item.id
                          ? { ...value, minimized: true }
                          : value,
                      ),
                    )
                  }
                >
                  <span className={styles.minimizeGlyph} />
                </button>
                <button
                  type="button"
                  aria-label={item.maximized ? "복원" : "최대화"}
                  onClick={() => toggleMaximize(item)}
                >
                  <span className={styles.maximizeGlyph} />
                </button>
                <button
                  type="button"
                  aria-label="닫기"
                  className={styles.closeButton}
                  onClick={() => closeWindow(item.id)}
                >
                  <span className={styles.closeGlyph} />
                </button>
              </div>
            </div>

            <div className={styles.windowToolbar}>
              <button
                type="button"
                className={styles.pixelButton}
                disabled={item.path.length <= 1}
                aria-label="뒤로"
                onClick={() => navigateWindow(item.id, item.path.length - 2)}
              >
                ←
              </button>
              <form
                className={styles.addressBar}
                aria-label="폴더 주소"
                onSubmit={(event) => {
                  event.preventDefault();
                  void navigateAddress(item.id);
                }}
              >
                <input
                  data-testid={`folder-address-${item.id}`}
                  aria-label="폴더 주소 입력"
                  aria-invalid={addressState.error ? true : undefined}
                  value={addressState.value}
                  disabled={addressState.busy}
                  spellCheck={false}
                  onChange={(event) =>
                    setAddressStates((current) => ({
                      ...current,
                      [item.id]: {
                        value: event.target.value,
                        busy: false,
                        error: null,
                      },
                    }))
                  }
                />
                {addressState.error && (
                  <span className={styles.addressError} role="alert">
                    {addressState.error}
                  </span>
                )}
              </form>
              <button
                type="button"
                className={styles.toolbarAction}
                disabled={item.data.loading}
                onClick={(event) =>
                  openDialog(
                    { kind: "create", scopeId: item.id, value: "" },
                    event.currentTarget,
                  )
                }
              >
                + 폴더
              </button>
              <button
                type="button"
                className={styles.toolbarAction}
                disabled={item.data.loading}
                onClick={() => requestUpload(item.id)}
              >
                ↑ 올리기
              </button>
              <button
                type="button"
                className={`${styles.toolbarAction} ${styles.folderNoteButton}`}
                data-testid={`folder-note-${item.id}`}
                onClick={() => void openFolderNote(item)}
              >
                <span className={styles.folderNoteGlyph} aria-hidden="true" />
                폴더 메모
              </button>
            </div>

            <div className={styles.windowBody}>{renderCanvas(item.id)}</div>

            <footer className={styles.windowStatus}>
              <span>{item.data.entries.length}개 항목</span>
              {selectedEntry ? (
                <span className={styles.selectedMeta}>
                  {selectedEntry.name} · {formatSize(selectedEntry.size)} · {formatDate(selectedEntry.modifiedAt)}
                </span>
              ) : (
                <span>아이콘을 끌어 위치를 바꾸고, 폴더 위에 놓으면 그 안으로 옮겨져요</span>
              )}
            </footer>
            <button
              type="button"
              className={styles.resizeHandle}
              aria-label="창 크기 변경"
              onPointerDown={(event) => resizeWindow(event, item)}
            />
          </section>
        );
      })}

      {trashWindow && (
        <section
          className={`${styles.folderWindow} ${styles.trashWindow}`}
          style={{
            left: trashWindow.x,
            top: trashWindow.y,
            zIndex: trashWindow.z,
          }}
          aria-label="휴지통 창"
          onPointerDown={() => {
            const z = ++zRef.current;
            setTrashWindow((current) =>
              current ? { ...current, z } : current,
            );
          }}
        >
          <div
            className={styles.windowTitlebar}
            onPointerDown={moveTrashWindow}
          >
            <span className={styles.trashGlyph} aria-hidden="true" />
            <strong>휴지통</strong>
            {trashWindow.loading && (
              <span className={styles.titleLoading}>여는 중</span>
            )}
            <div className={styles.windowControls}>
              <button
                type="button"
                aria-label="닫기"
                className={styles.closeButton}
                onClick={() => setTrashWindow(null)}
              >
                <span className={styles.closeGlyph} />
              </button>
            </div>
          </div>

          <div className={styles.trashBody}>
            {trashWindow.error && (
              <p className={styles.trashMessage} role="alert">
                {trashWindow.error}
              </p>
            )}
            {!trashWindow.error &&
              !trashWindow.loading &&
              trashWindow.entries.length === 0 && (
                <p className={styles.trashMessage}>
                  휴지통이 비어 있어요.
                  <small>삭제한 항목은 여기에 30일 동안 보관됩니다.</small>
                </p>
              )}
            <ul className={styles.trashList}>
              {trashWindow.entries.map((entry) => (
                <li key={entry.id} className={styles.trashRow}>
                  <PixelFileIcon entry={entry} size={30} />
                  <div className={styles.trashInfo}>
                    <span className={styles.trashName} title={entry.name}>
                      {entry.name}
                    </span>
                    <span className={styles.trashMeta}>
                      {formatSize(entry.size)} ·{" "}
                      {entry.trashedAt
                        ? `${formatDate(entry.trashedAt)} 삭제`
                        : "휴지통 보관 중"}
                    </span>
                  </div>
                  {trashWindow.confirmId === entry.id ? (
                    <span className={styles.trashActions}>
                      <button
                        type="button"
                        className={styles.trashDanger}
                        disabled={trashWindow.busyId !== null}
                        onClick={() =>
                          void trashAction("purge", entry.id, entry.version)
                        }
                      >
                        삭제 확인
                      </button>
                      <button
                        type="button"
                        disabled={trashWindow.busyId !== null}
                        onClick={() =>
                          setTrashWindow((current) =>
                            current ? { ...current, confirmId: null } : current,
                          )
                        }
                      >
                        취소
                      </button>
                    </span>
                  ) : (
                    <span className={styles.trashActions}>
                      <button
                        type="button"
                        disabled={trashWindow.busyId !== null}
                        onClick={() => void trashAction("restore", entry.id)}
                      >
                        {trashWindow.busyId === entry.id ? "…" : "복원"}
                      </button>
                      <button
                        type="button"
                        className={styles.trashDanger}
                        disabled={trashWindow.busyId !== null}
                        onClick={() =>
                          setTrashWindow((current) =>
                            current
                              ? { ...current, confirmId: entry.id }
                              : current,
                          )
                        }
                      >
                        완전 삭제
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <footer className={styles.windowStatus}>
            <span>{trashWindow.entries.length}개 항목 · 30일 후 자동 삭제</span>
            {trashWindow.entries.length > 0 &&
              (trashWindow.confirmId === "__empty__" ? (
                <span className={styles.trashActions}>
                  <button
                    type="button"
                    className={styles.trashDanger}
                    disabled={trashWindow.busyId !== null}
                    onClick={() => void trashAction("empty")}
                  >
                    모두 삭제 확인
                  </button>
                  <button
                    type="button"
                    disabled={trashWindow.busyId !== null}
                    onClick={() =>
                      setTrashWindow((current) =>
                        current ? { ...current, confirmId: null } : current,
                      )
                    }
                  >
                    취소
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.trashDanger}
                  disabled={trashWindow.busyId !== null}
                  onClick={() =>
                    setTrashWindow((current) =>
                      current
                        ? { ...current, confirmId: "__empty__" }
                        : current,
                    )
                  }
                >
                  비우기…
                </button>
              ))}
          </footer>
        </section>
      )}

      {previewWindow && (
        <section
          ref={previewRef}
          className={`${styles.folderWindow} ${styles.previewWindow}`}
          style={{
            left: previewWindow.x,
            top: previewWindow.y,
            zIndex: previewWindow.z,
          }}
          role="dialog"
          aria-label={`${previewWindow.entry.name} 미리보기`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closePreview();
          }}
          onPointerDown={() => {
            const z = ++zRef.current;
            setPreviewWindow((current) =>
              current ? { ...current, z } : current,
            );
          }}
        >
          <div
            className={styles.windowTitlebar}
            onPointerDown={movePreviewWindow}
          >
            <PixelFileIcon entry={previewWindow.entry} size={16} />
            <strong className={styles.previewTitle}>
              {previewWindow.entry.name}
            </strong>
            <div className={styles.windowControls}>
              <button
                type="button"
                aria-label="닫기"
                data-preview-initial-focus
                className={styles.closeButton}
                onClick={closePreview}
              >
                <span className={styles.closeGlyph} />
              </button>
            </div>
          </div>

          <div
            className={`${styles.previewBody} ${
              previewWindow.kind === "text" ? styles.previewBodyText : ""
            }`}
          >
            {previewWindow.kind === "image" && (
              // 미리보기 원본 크기를 알 수 없어 img를 그대로 쓴다 (next/image 부적합).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl(previewWindow.entry)}
                alt={previewWindow.entry.name}
                className={styles.previewImage}
              />
            )}
            {previewWindow.kind === "video" && (
              <video
                src={previewUrl(previewWindow.entry)}
                controls
                className={styles.previewMedia}
              />
            )}
            {previewWindow.kind === "audio" && (
              <audio
                src={previewUrl(previewWindow.entry)}
                controls
                className={styles.previewAudio}
              />
            )}
            {previewWindow.kind === "pdf" && (
              <iframe
                src={previewUrl(previewWindow.entry)}
                title={previewWindow.entry.name}
                className={styles.previewFrame}
              />
            )}
            {previewWindow.kind === "text" &&
              (previewWindow.textLoading ? (
                <p className={styles.trashMessage} role="status">
                  여는 중…
                </p>
              ) : previewWindow.textError ? (
                <p className={styles.trashMessage} role="alert">
                  {previewWindow.textError}
                </p>
              ) : (
                <div className={styles.textEditor}>
                  {previewReadOnlyReason && (
                    <p className={styles.editorWarning} role="status">
                      {previewReadOnlyReason}
                    </p>
                  )}
                  <textarea
                    className={styles.previewText}
                    aria-label={`${previewWindow.entry.name} 내용`}
                    value={previewWindow.text ?? ""}
                    readOnly={!!previewReadOnlyReason}
                    onChange={(event) =>
                      setPreviewWindow((current) =>
                        current
                          ? {
                              ...current,
                              text: event.target.value,
                              textSaveError: null,
                              textConflict: false,
                            }
                          : current,
                      )
                    }
                  />
                  {previewWindow.textSaveError && (
                    <p
                      className={styles.editorWarning}
                      role={previewWindow.textConflict ? "alert" : "status"}
                    >
                      {previewWindow.textSaveError}
                    </p>
                  )}
                </div>
              ))}
          </div>

          <footer className={styles.windowStatus}>
            <span>
              {formatSize(previewWindow.entry.size)} ·{" "}
              {formatDate(previewWindow.entry.modifiedAt)}
            </span>
            <span className={styles.previewActions}>
              {previewWindow.kind === "text" && (
                <button
                  type="button"
                  className={styles.editorSave}
                  disabled={
                    previewWindow.textLoading ||
                    previewWindow.textSaving ||
                    !!previewWindow.textError ||
                    !!previewReadOnlyReason ||
                    previewWindow.text === previewWindow.originalText
                  }
                  onClick={() => void savePreviewText()}
                >
                  {previewWindow.textSaving ? "저장 중…" : "저장"}
                </button>
              )}
              <button
                type="button"
                className={styles.previewDownload}
                onClick={() => void downloadEntry(previewWindow.entry)}
              >
                ↓ 다운로드
              </button>
            </span>
          </footer>
        </section>
      )}

      {folderNoteWindow && (
        <section
          className={`${styles.folderWindow} ${styles.noteWindow}`}
          style={{
            left: folderNoteWindow.x,
            top: folderNoteWindow.y,
            zIndex: folderNoteWindow.z,
          }}
          role="dialog"
          aria-label={`${folderNoteWindow.folderName} 폴더 메모`}
          data-testid="folder-note-window"
          onPointerDown={() =>
            setFolderNoteWindow((current) =>
              current ? { ...current, z: ++zRef.current } : current,
            )
          }
        >
          <div
            className={styles.windowTitlebar}
            onPointerDown={moveFolderNoteWindow}
          >
            <span className={styles.folderNoteGlyph} aria-hidden="true" />
            <strong>{folderNoteWindow.folderName} · 폴더 메모</strong>
            <div className={styles.windowControls}>
              <button
                type="button"
                aria-label="닫기"
                className={styles.closeButton}
                onClick={closeFolderNote}
              >
                <span className={styles.closeGlyph} />
              </button>
            </div>
          </div>
          <div className={styles.noteBody}>
            {folderNoteWindow.loading ? (
              <p className={styles.noteMessage} role="status">
                메모를 여는 중…
              </p>
            ) : folderNoteWindow.error && !folderNoteWindow.conflict ? (
              <p className={styles.noteMessage} role="alert">
                {folderNoteWindow.error}
              </p>
            ) : (
              <>
                <textarea
                  value={folderNoteWindow.content}
                  aria-label="폴더 메모 내용"
                  onChange={(event) =>
                    setFolderNoteWindow((current) =>
                      current
                        ? {
                            ...current,
                            content: event.target.value,
                            error: null,
                            conflict: false,
                          }
                        : current,
                    )
                  }
                />
                {folderNoteWindow.error && (
                  <p className={styles.editorWarning} role="alert">
                    {folderNoteWindow.error}
                  </p>
                )}
              </>
            )}
          </div>
          <footer className={styles.windowStatus}>
            <span>
              {folderNoteWindow.content === folderNoteWindow.originalContent
                ? "저장됨"
                : "저장하지 않은 변경 있음"}
            </span>
            <button
              type="button"
              className={styles.editorSave}
              disabled={
                folderNoteWindow.loading ||
                folderNoteWindow.saving ||
                !!(folderNoteWindow.error && !folderNoteWindow.conflict) ||
                folderNoteWindow.content === folderNoteWindow.originalContent
              }
              onClick={() => void saveFolderNote()}
            >
              {folderNoteWindow.saving ? "저장 중…" : "저장"}
            </button>
          </footer>
        </section>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={(event) => {
          if (event.target.files) {
            void uploadFiles(event.target.files, uploadScopeRef.current);
          }
          event.target.value = "";
        }}
      />

      <button
        type="button"
        className={`${styles.trashLauncher} ${
          dropTargetKey === "trash" ? styles.trashDropTarget : ""
        }`}
        data-drop-trash="true"
        aria-label="휴지통 열기"
        onClick={openTrash}
      >
        <TrashCanIcon />
        <span>휴지통</span>
      </button>

      <footer className={styles.taskBar}>
        <button
          ref={deskButtonRef}
          type="button"
          className={styles.deskButton}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setContextMenu({
              x: logicalClientCoordinate(rect.left, uiScale),
              y: Math.max(
                8,
                logicalClientCoordinate(rect.top, uiScale) - 338,
              ),
              scopeId: ROOT_SCOPE,
              opener: event.currentTarget,
            });
          }}
        >
          <span className={styles.deskButtonMark} aria-hidden="true" />
          책상
        </button>
        <div className={styles.windowTasks} aria-label="열린 폴더">
          {deskWindows.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`${styles.taskButton} ${
                !item.minimized &&
                item.z === Math.max(...deskWindows.map((value) => value.z))
                  ? styles.activeTask
                  : ""
              }`}
              onClick={() => focusWindow(item.id)}
            >
              <span className={styles.miniFolder} aria-hidden="true" />
              <span className={styles.taskTitle}>{item.path.at(-1)?.name}</span>
            </button>
          ))}
        </div>
        {activeTransfers.length > 0 && (
          <div className={styles.uploadChip} role="status">
            <span className={styles.uploadArrow} aria-hidden="true">↕</span>
            <span>
              전송 중 {activeTransfers.length}개 · {activeTransfers[0].name}
              {" · "}
              {transferProgressText(activeTransfers[0])}
            </span>
          </div>
        )}
        <label className={styles.downloadPreference}>
          <input
            type="checkbox"
            checked={downloadFirst}
            onChange={(event) => selectDownloadFirst(event.target.checked)}
          />
          <span className={styles.preferenceCheck} aria-hidden="true" />
          <span>다운로드 우선</span>
        </label>
        <div className={styles.userTray}>
          {isAdmin && (
            <a href="/admin" className={styles.trayLink}>
              사용자 관리
            </a>
          )}
          <span className={styles.userName} title={userName}>
            {userName}
            {isGuest ? " · 손님" : ""}
          </span>
          <button type="button" className={styles.trayLink} onClick={() => void logout()}>
            나가기
          </button>
          <time className={styles.clock} dateTime={clock?.toISOString()}>
            {clock
              ? clock.toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "--:--"}
          </time>
        </div>
      </footer>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label={contextMenu.entry ? `${contextMenu.entry.name} 메뉴` : "바탕화면 메뉴"}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={handleContextMenuKeyDown}
        >
          {contextMenu.entry ? (
            <>
              <MenuButton
                onClick={() => {
                  const entry = contextMenu.entry!;
                  const action = fileActivationAction(entry, false);
                  if (action === "folder") {
                    openFolder(entry, contextMenu.scopeId);
                  } else if (action === "preview") {
                    openPreview(entry);
                  } else {
                    void downloadEntry(entry);
                  }
                  setContextMenu(null);
                }}
              >
                {contextMenu.entry.isFolder
                  ? "열기"
                  : previewKindOf(contextMenu.entry)
                    ? "브라우저에서 열기"
                    : "다운로드"}
                <kbd>Enter</kbd>
              </MenuButton>
              {!contextMenu.entry.isFolder &&
                previewKindOf(contextMenu.entry) && (
                  <MenuButton
                    onClick={() => {
                      void downloadEntry(contextMenu.entry!);
                      setContextMenu(null);
                    }}
                  >
                    다운로드
                  </MenuButton>
                )}
              <div className={styles.menuSeparator} />
              {scopeParentFolderId(contextMenu.scopeId) && (
                <MenuButton
                  onClick={() => {
                    const sourceScopeId = contextMenu.scopeId;
                    const entry = contextMenu.entry!;
                    const targetFolderId = scopeParentFolderId(sourceScopeId);
                    setContextMenu(null);
                    if (!targetFolderId) {
                      setNotice("상위 폴더를 찾지 못했습니다 — 새로고침해 주세요");
                      return;
                    }
                    void moveEntry(sourceScopeId, entry, targetFolderId);
                  }}
                >
                  상위 폴더로 이동
                </MenuButton>
              )}
              <MenuButton
                onClick={() => {
                  openDialog(
                    {
                      kind: "rename",
                      scopeId: contextMenu.scopeId,
                      entry: contextMenu.entry!,
                      value: contextMenu.entry!.name,
                    },
                    contextMenu.opener,
                  );
                  setContextMenu(null);
                }}
              >
                이름 바꾸기 <kbd>F2</kbd>
              </MenuButton>
              {isAdmin && (
                <MenuButton
                  onClick={() => openShareDialog(contextMenu.entry!)}
                >
                  Google Drive로 공유…
                </MenuButton>
              )}
              <MenuButton
                danger
                onClick={() => {
                  openDialog(
                    {
                      kind: "delete",
                      scopeId: contextMenu.scopeId,
                      entry: contextMenu.entry!,
                    },
                    contextMenu.opener,
                  );
                  setContextMenu(null);
                }}
              >
                삭제… <kbd>Del</kbd>
              </MenuButton>
            </>
          ) : (
            <>
              <MenuButton
                onClick={() => {
                  openDialog(
                    {
                      kind: "create",
                      scopeId: contextMenu.scopeId,
                      value: "",
                    },
                    contextMenu.opener,
                  );
                  setContextMenu(null);
                }}
              >
                새 폴더 <kbd>⌘N</kbd>
              </MenuButton>
              <MenuButton
                onClick={() => void createNotepad(contextMenu.scopeId)}
              >
                새 메모장
              </MenuButton>
              <MenuButton onClick={() => requestUpload(contextMenu.scopeId)}>
                파일 업로드…
              </MenuButton>
              <div className={styles.menuSeparator} />
              <MenuButton
                onClick={() => {
                  void refreshScope(contextMenu.scopeId);
                  setContextMenu(null);
                }}
              >
                새로고침 <kbd>F5</kbd>
              </MenuButton>
              {contextMenu.scopeId === ROOT_SCOPE && (
                <>
                  <div className={styles.menuSeparator} />
                  {WALLPAPERS.map((wallpaper) => (
                    <MenuButton
                      key={wallpaper.id}
                      onClick={() => selectWallpaper(wallpaper.id)}
                    >
                      배경 — {wallpaper.name}
                      {wallpaperId === wallpaper.id && <kbd>✓</kbd>}
                    </MenuButton>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {isAdmin && shareEntry && (
        <ShareDialog
          entry={shareEntry}
          onClose={closeShareDialog}
          onNotice={setNotice}
        />
      )}

      {dialog && (
        <div
          className={styles.dialogBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !dialogBusy) closeDialog();
          }}
        >
          <section
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="desk-dialog-title"
            onKeyDown={handleDialogKeyDown}
          >
            <header className={styles.dialogTitlebar}>
              <strong id="desk-dialog-title">
                {dialog.kind === "create"
                  ? "새 폴더"
                  : dialog.kind === "rename"
                    ? "이름 바꾸기"
                    : "삭제 확인"}
              </strong>
              <button
                type="button"
                aria-label="닫기"
                disabled={dialogBusy}
                onClick={closeDialog}
              >
                ×
              </button>
            </header>
            <form
              className={styles.dialogBody}
              onSubmit={(event) => {
                event.preventDefault();
                void submitDialog();
              }}
            >
              {dialog.kind === "delete" ? (
                <>
                  <PixelFileIcon entry={dialog.entry} size={52} />
                  <p>
                    <strong>‘{dialog.entry.name}’</strong>을 삭제할까요?
                    <small>
                      휴지통으로 이동하며, 30일이 지나면 자동으로 완전히
                      삭제됩니다.
                    </small>
                  </p>
                </>
              ) : (
                <label>
                  <span>{dialog.kind === "create" ? "폴더 이름" : "새 이름"}</span>
                  <input
                    data-dialog-initial-focus
                    value={dialog.value}
                    maxLength={255}
                    onChange={(event) =>
                      setDialog({ ...dialog, value: event.target.value })
                    }
                    placeholder={dialog.kind === "create" ? "예: 여름 여행" : undefined}
                  />
                </label>
              )}
              <div className={styles.dialogActions}>
                <button
                  type="button"
                  data-dialog-initial-focus={
                    dialog.kind === "delete" ? true : undefined
                  }
                  className={styles.secondaryButton}
                  disabled={dialogBusy}
                  onClick={closeDialog}
                >
                  취소
                </button>
                <button
                  type="submit"
                  className={dialog.kind === "delete" ? styles.dangerButton : styles.primaryButton}
                  disabled={
                    dialogBusy ||
                    (dialog.kind !== "delete" && !dialog.value.trim())
                  }
                >
                  {dialogBusy
                    ? "처리 중…"
                    : dialog.kind === "create"
                      ? "만들기"
                      : dialog.kind === "rename"
                        ? "저장"
                        : "삭제하기"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {notice && (
        <button
          type="button"
          className={styles.toast}
          aria-live="polite"
          onClick={() => setNotice(null)}
        >
          <span aria-hidden="true">◆</span>
          {notice}
        </button>
      )}

      {activeSelection && (
        <div className={styles.selectionHint} aria-live="polite">
          {activeSelection.name} · {formatSize(activeSelection.size)}
        </div>
      )}
      </div>
      {dragGhost && (
        <div
          className={styles.dragGhost}
          data-testid="file-drag-ghost"
          style={{
            left: dragGhost.clientX,
            top: dragGhost.clientY,
            "--drag-scale": uiScale,
          } as CSSProperties}
          aria-hidden="true"
        >
          <PixelFileIcon entry={dragGhost.entry} size={54} />
          <span title={dragGhost.entry.name}>{dragGhost.entry.name}</span>
        </div>
      )}
    </main>
  );
}
