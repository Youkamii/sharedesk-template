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
