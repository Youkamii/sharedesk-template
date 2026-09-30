// 위젯 화면의 순수 함수 — 정렬·최근 파일·모드 저장·주기 확인 간격.
// 화면 컴포넌트(src/app/widget/WidgetView.tsx)에서 상태 없이 쓰이고 tests/widget.test.ts가 고정한다.

import type { Entry } from "@/lib/storage/types";

export type WidgetMode = "desk" | "window";

export const WIDGET_MODE_KEY = "sharedesk.widget-mode";
export const WIDGET_RECENT_LIMIT = 5;
// 웹 데스크와 같은 간격(FilesView LIST_POLL_MS·PRESENCE_HEARTBEAT_MS)
export const WIDGET_LIST_POLL_MS = 30_000;
export const WIDGET_PRESENCE_MS = 30_000;
// 창이 트레이에 숨어 있는 동안은 더 느리게 — 서버리스 호출을 아낀다
export const WIDGET_HIDDEN_POLL_MS = 5 * 60_000;

export function parseWidgetMode(value: unknown): WidgetMode {
  return value === "window" ? "window" : "desk";
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readWidgetMode(storage: KeyValueStorage | null): WidgetMode {
  try {
    return parseWidgetMode(storage?.getItem(WIDGET_MODE_KEY));
  } catch {
    return "desk";
  }
}

export function writeWidgetMode(
  storage: KeyValueStorage | null,
  mode: WidgetMode,
): void {
  try {
    storage?.setItem(WIDGET_MODE_KEY, mode);
  } catch {
    // 저장소가 막힌 환경에서는 이번 실행 동안만 기억한다
  }
}

// 자동 격자: 폴더 먼저, 그다음 이름순. 위젯은 공유 배치를 따르지 않는다 —
// 손바닥 크기 화면에 큰 바탕화면 배치를 축소하면 아이콘이 겹친다.
export function sortWidgetEntries<T extends Pick<Entry, "name" | "isFolder">>(
  entries: readonly T[],
  bcp47 = "en-US",
): T[] {
  const collator = new Intl.Collator(bcp47, { numeric: true, sensitivity: "base" });
  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return collator.compare(a.name, b.name) || a.name.localeCompare(b.name);
  });
}

// 창가 모드의 "최근 올라온 파일": 파일만, 수정 시각 내림차순, 시각 없는 것은 뒤로.
export function recentWidgetFiles<
  T extends Pick<Entry, "name" | "isFolder" | "modifiedAt">,
>(entries: readonly T[], limit = WIDGET_RECENT_LIMIT): T[] {
  const stamp = (entry: T) => {
    const time = entry.modifiedAt ? Date.parse(entry.modifiedAt) : Number.NaN;
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
  };
  return entries
    .filter((entry) => !entry.isFolder)
    .sort((a, b) => stamp(b) - stamp(a) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}

export function widgetPollInterval(baseMs: number, hidden: boolean): number {
  return hidden ? Math.max(baseMs, WIDGET_HIDDEN_POLL_MS) : baseMs;
}

// 껍데기가 창을 트레이로 숨겨도 WebView2는 페이지의 document.hidden을 바꾸지 않는다. 그래서 껍데기가
// 이 표식을 심고 이 이벤트를 쏜다 (widget/src-tauri/src/lib.rs tell_page_visibility). 브라우저에서는
// document.hidden만 본다.
export const WIDGET_HIDDEN_FLAG = "__sharedeskWidgetHidden";
export const WIDGET_VISIBILITY_EVENT = "sharedesk:widget-visibility";

export function isWidgetHidden(doc: { hidden: boolean }, host: unknown): boolean {
  return (
    doc.hidden ||
    (host as Record<string, unknown> | null)?.[WIDGET_HIDDEN_FLAG] === true
  );
}

// 껍데기(Tauri)가 주입하는 IPC — 브라우저에서는 없다. 위젯 모드 화면은 껍데기 안에서만
// 그려지지만, 호출부는 항상 없을 수 있음을 전제로 한다.
interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export function tauriInternals(host: unknown): TauriInternals | null {
  const candidate = (host as { __TAURI_INTERNALS__?: unknown } | null)
    ?.__TAURI_INTERNALS__;
  return candidate &&
    typeof (candidate as TauriInternals).invoke === "function"
    ? (candidate as TauriInternals)
    : null;
}

// 껍데기의 hide_widget 명령은 창 위치를 적고 트레이 메뉴 라벨까지 맞춘다 — 창 플러그인의 hide보다 이쪽.
export async function hideWidgetWindow(host: unknown): Promise<boolean> {
  const internals = tauriInternals(host);
  if (!internals) return false;
  try {
    await internals.invoke("hide_widget");
    return true;
  } catch {
    return false;
  }
}

// 껍데기는 파일 드롭을 웹뷰에 그대로 맡긴다(HTML5 업로드를 위해). 그래서 화면이 처리하지 않은 드롭은
// Chromium 기본 동작대로 그 파일로 이동해 버린다 — 머리띠·창가 모드·로그인 화면에 놓아도 데스크가
// 사라지지 않게, 아무도 처리하지 않은 드래그·드롭은 여기서 막는다.
interface DropGuardTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export function installStrayDropGuard(target: DropGuardTarget): () => void {
  const onDrag = (event: Event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) transfer.dropEffect = "none";
  };
  const onDrop = (event: Event) => {
    if (!event.defaultPrevented) event.preventDefault();
  };
  target.addEventListener("dragover", onDrag);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDrag);
    target.removeEventListener("drop", onDrop);
  };
}

// ── 벽 붙임 (#28) ───────────────────────────────────────────────────────────
// 서랍/창가와 따로 노는 배치 토글. 켜면 껍데기가 창을 가까운 좌우 벽에 붙이고, 화면은 내용 전체를
// 벽 너머로 밀어내 손잡이만 남긴다. 커서 판정·클릭 투과는 껍데기(widget/src-tauri/src/wall.rs)가
// 맡고, 화면은 "마우스를 받아야 하는 영역"만 알린다. 켜짐 여부는 이 브라우저 저장소가 원본이다 —
// 페이지가 로드될 때마다 껍데기에 다시 켜 달라고 한다.

export type WallSide = "left" | "right";

export const WIDGET_WALL_KEY = "sharedesk.widget-wall";
// 껍데기가 쏘는 이벤트 — wall.rs의 HOVER_EVENT·SIDE_EVENT와 같은 이름
export const WIDGET_WALL_HOVER_EVENT = "sharedesk:wall-hover";
export const WIDGET_WALL_SIDE_EVENT = "sharedesk:wall-side";
// 손잡이 둘레 여유 — 벽 끝에서 커서가 살짝 벗어나도 붙잡는다
export const WALL_HANDLE_SLACK = 4;

export function parseWidgetWall(value: unknown): boolean {
  return value === "on";
}

export function readWidgetWall(storage: KeyValueStorage | null): boolean {
  try {
    return parseWidgetWall(storage?.getItem(WIDGET_WALL_KEY));
  } catch {
    return false;
  }
}

export function writeWidgetWall(storage: KeyValueStorage | null, on: boolean): void {
  try {
    storage?.setItem(WIDGET_WALL_KEY, on ? "on" : "off");
  } catch {
    // 저장소가 막힌 환경에서는 이번 실행 동안만 기억한다
  }
}

export function parseWallSide(value: unknown): WallSide | null {
  return value === "left" || value === "right" ? value : null;
}

export type WallRect = [x: number, y: number, width: number, height: number];

interface BoxLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

// 껍데기에 알릴 영역(창 안쪽 논리 좌표). 숨김 중엔 손잡이+여유, 펼침 중엔 창 전체.
export function wallZoneRect(
  expanded: boolean,
  handle: BoxLike,
  viewport: { width: number; height: number },
): WallRect {
  if (expanded) return [0, 0, viewport.width, viewport.height];
  return [
    handle.left - WALL_HANDLE_SLACK,
    handle.top - WALL_HANDLE_SLACK,
    handle.width + WALL_HANDLE_SLACK * 2,
    handle.height + WALL_HANDLE_SLACK * 2,
  ];
}

// 커서가 떠나도 접으면 안 되는 때: 우클릭 메뉴가 열려 있을 때, 올리는 중일 때, 파일을 끌어와 위에 있을 때
export function wallHold(state: {
  menuOpen: boolean;
  uploading: boolean;
  fileOver: boolean;
}): boolean {
  return state.menuOpen || state.uploading || state.fileOver;
}

// 껍데기에 벽 붙임을 켜 달라고 한다. 붙인 벽을 돌려주고, 껍데기가 없거나 옛 껍데기라
// 명령이 거부되면 null — 화면은 떠 있는 위젯 그대로 두고 업데이트를 안내한다.
export async function enableWidgetWall(host: unknown): Promise<WallSide | null> {
  const internals = tauriInternals(host);
  if (!internals) return null;
  try {
    return parseWallSide(await internals.invoke("set_wall_mode", { enabled: true }));
  } catch {
    return null;
  }
}

export async function disableWidgetWall(host: unknown): Promise<void> {
  try {
    await tauriInternals(host)?.invoke("set_wall_mode", { enabled: false });
  } catch {
    // 옛 껍데기는 켠 적도 없다
  }
}

export async function reportWallZone(
  host: unknown,
  zone: { rect: WallRect; hold: boolean } | null,
): Promise<void> {
  try {
    await tauriInternals(host)?.invoke("set_wall_zone", { zone });
  } catch {
    // 다음 보고(크기 변경·상태 변화)가 다시 시도한다
  }
}
