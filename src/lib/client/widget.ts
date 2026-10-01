// 위젯 화면의 순수 함수 — 정렬·최근 파일·모드 저장·주기 확인 간격.
// 화면 컴포넌트(src/app/widget/WidgetView.tsx)에서 상태 없이 쓰이고 tests/widget.test.ts가 고정한다.

import { downloadFileName } from "@/lib/client/file-activation";
import type { TransferProgress } from "@/lib/client/transfer";
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

// ── 끌어내기 (#29) ──────────────────────────────────────────────────────────
// 서랍의 파일 아이콘을 탐색기 폴더로 끌어 놓으면 그 폴더에 받아진다. 화면이 dragstart에서
// setData("DownloadURL", …)에 싣는 값을 만든다 — Chromium(WebView2)의 형식은
// "<mime>:<파일 이름>:<절대 주소>"이고 앞의 두 콜론이 구분자다. 놓는 순간 탐색기가 이 주소를
// 세션 쿠키와 함께 받아 간다(2026-10-01 실측). 맥(WKWebView)은 DownloadURL을 모른다 — 아무 일 없다.
// - 이름은 우클릭 메뉴의 내려받기와 같은 규칙(downloadFileName — 구글 문서는 PDF로 받아지므로
//   .pdf)이고, 이름 안의 콜론은 "_"로 바꾼다.
// - mime 칸에 콜론이 섞이면 이름·주소 칸이 밀려 다른 서버 주소로 받을 수 있다 — 업로드는 mimeType을
//   검증 없이 저장하고 서랍 목록이 그대로 준다. "형식/종류"꼴이 아니면 application/octet-stream.
const SAFE_MIME = /^[\w.+-]+\/[\w.+-]+$/;

export function widgetDownloadUrlData(
  entry: Pick<Entry, "name" | "mimeType">,
  url: string,
): string {
  const mime =
    entry.mimeType && SAFE_MIME.test(entry.mimeType) ? entry.mimeType : "application/octet-stream";
  return `${mime}:${downloadFileName(entry).replace(/:/g, "_")}:${url}`;
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

// 켜 달라고 한 결과: 붙인 벽, 또는 못 쓰는 까닭. "unsupported"는 껍데기가 없거나 옛 껍데기라
// 명령이 없는 것(업데이트 안내), "failed"는 새 껍데기가 붙이지 못한 것(표식은 두고 다음 로드에 다시).
export type WallEnableResult = { side: WallSide } | { reason: "unsupported" | "failed" };

// Tauri 2가 없는 명령·막힌 명령을 거절할 때의 문구 (tauri 2.12 src/webview/mod.rs·src/ipc/authority.rs):
// "Command set_wall_mode not found", 릴리스 "Command set_wall_mode not allowed by ACL",
// 디버그 "set_wall_mode not allowed. Command not found" · "set_wall_mode not allowed on origin [...]".
// 껍데기 자신의 실패(한국어 Err 문구)는 여기에 걸리지 않는다.
const UNSUPPORTED_COMMAND = /\bnot (?:found|allowed)\b/i;

export function isUnsupportedCommandError(error: unknown): boolean {
  const text =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  return UNSUPPORTED_COMMAND.test(text);
}

export async function enableWidgetWall(host: unknown): Promise<WallEnableResult> {
  const internals = tauriInternals(host);
  if (!internals) return { reason: "unsupported" };
  try {
    const side = parseWallSide(await internals.invoke("set_wall_mode", { enabled: true }));
    return side ? { side } : { reason: "failed" };
  } catch (error) {
    return { reason: isUnsupportedCommandError(error) ? "unsupported" : "failed" };
  }
}

export async function disableWidgetWall(host: unknown): Promise<void> {
  try {
    await tauriInternals(host)?.invoke("set_wall_mode", { enabled: false });
  } catch {
    // 옛 껍데기는 켠 적도 없다
  }
}

// 전송 게이지(#31): 벽 붙임으로 접힌 동안 손잡이 테두리가 전송 진행률만큼 아래에서 위로 초록으로 찬다.
// 진행률은 활성 전송(올리기·받기 모두)의 합산 Σtransferred / Σtotal이다. 크기를 모르는 전송(total 없음·0 이하)은
// 분모·분자에서 뺀다 — 크기를 아는 전송이 하나도 없으면 ratio는 null(테두리 전체가 깜빡인다).
// 다 끝난 뒤 1초 동안 다 찬 채로 두는 것은 화면의 타이머가 맡는다.
export interface TransferGauge {
  ratio: number | null;
  active: boolean;
}

export function transferGauge(
  transfers: Iterable<Pick<TransferProgress, "transferred" | "total">>,
): TransferGauge {
  let active = false;
  let done = 0;
  let total = 0;
  for (const transfer of transfers) {
    active = true;
    const size = transfer.total;
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) continue;
    total += size;
    done += Math.min(Math.max(transfer.transferred, 0), size);
  }
  return { ratio: total > 0 ? done / total : null, active };
}

// 손잡이 테두리에 칠할 높이(px). 2px 칸으로 끊어 픽셀 느낌을 낸다. 조금이라도 나아갔으면 한 칸은 보이고,
// 다 찬 칸은 진행률이 1일 때만이다.
export const WALL_GAUGE_STEP_PX = 2;

export function wallGaugeFillPx(ratio: number, heightPx: number, stepPx = WALL_GAUGE_STEP_PX): number {
  if (!(ratio > 0) || !(heightPx > 0) || !(stepPx > 0)) return 0;
  const steps = Math.floor(heightPx / stepPx);
  return Math.min(steps, Math.max(1, Math.floor(ratio * steps))) * stepPx;
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

// ── 압정 (#30) ──────────────────────────────────────────────────────────────
// 배치 모드는 셋 중 하나다: 떠 있기(기본, 항상 위) · 벽 붙임 · 압정(다른 창 뒤, 바탕화면 위에 고정).
// 압정의 원본은 껍데기 설정이다 — 화면은 로드 때 widget_placement로 읽어 단추를 맞추고 set_pinned로
// 켜고 끈다. 벽 붙임과는 하나만 켜지고, 바꾸는 순서(켜려는 쪽의 반대편을 먼저 끈다)는 화면이 맡는다.
// 설계와 OS별 구현은 widget/README.md.

export type WidgetPlacement = "floating" | "wall" | "pinned";
export type PlacementStep = { wall: boolean } | { pinned: boolean };

// 껍데기가 스스로 압정을 풀었을 때(트레이 "항상 위", 압정인 채 벽 붙임 요청) 쏘는 이벤트 —
// widget/src-tauri/src/lib.rs의 PINNED_EVENT와 같은 이름. detail은 압정 여부(boolean).
export const WIDGET_PINNED_EVENT = "sharedesk:widget-pinned";

// 머리띠 단추가 보여 줄 배치. 벽 붙임을 켜면 껍데기가 압정을 풀므로 둘 다 켜져 있으면 벽이다.
export function widgetPlacement(wallOn: boolean, pinned: boolean | null): WidgetPlacement {
  if (wallOn) return "wall";
  return pinned === true ? "pinned" : "floating";
}

// 단추 하나(벽·압정)를 눌렀을 때 차례로 할 일. 켜진 쪽을 누르면 끄기만, 다른 쪽이 켜져 있으면
// 그쪽을 먼저 끄고 누른 쪽을 켠다 — 두 배치가 함께 켜지는 순간이 없게.
export function placementSteps(
  current: WidgetPlacement,
  pressed: "wall" | "pinned",
): PlacementStep[] {
  const set = (mode: "wall" | "pinned", on: boolean): PlacementStep =>
    mode === "wall" ? { wall: on } : { pinned: on };
  if (current === pressed) return [set(pressed, false)];
  const steps: PlacementStep[] = [];
  if (current !== "floating") steps.push(set(current, false));
  steps.push(set(pressed, true));
  return steps;
}

// 지금 압정인지. 껍데기가 없거나 옛 껍데기(명령 없음 — 벽 붙임과 같은 판정)면 null:
// 단추를 누르면 업데이트를 안내한다. 새 껍데기가 답하지 못한 것은 꺼짐으로 본다.
export async function readWidgetPinned(host: unknown): Promise<boolean | null> {
  const internals = tauriInternals(host);
  if (!internals) return null;
  try {
    const placement = (await internals.invoke("widget_placement")) as { pinned?: unknown } | null;
    return placement?.pinned === true;
  } catch (error) {
    return isUnsupportedCommandError(error) ? null : false;
  }
}

// 압정을 켜고 끈다. 껍데기가 적용한 값, 바꾸지 못했으면 null.
export async function setWidgetPinned(host: unknown, enabled: boolean): Promise<boolean | null> {
  const internals = tauriInternals(host);
  if (!internals) return null;
  try {
    const applied = await internals.invoke("set_pinned", { enabled });
    return typeof applied === "boolean" ? applied : null;
  } catch {
    return null;
  }
}
