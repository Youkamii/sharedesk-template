import type { EntryAudit } from "@/lib/entry-audit";
import type { StorageSearchResult } from "@/lib/search";

// 최근 파일 창(#16 C-1) — 서버와 화면이 함께 쓰는 순수 모듈(저장소를 모른다).
//
// 재료는 항목별 내력(entry-audit) 하나다: 업로드는 uploadedAt, 내용 수정·이름
// 변경·이동은 changes. 기록은 최선 노력이라 기록이 생기기 전의 일은 나타나지
// 않는다. 지금 이름·위치는 저장소 목록이 진실 원천이고(recent-files-load가
// 찾는다), 내력의 이름은 항목이 사라졌을 때만 쓴다.

// 기간 칩 — 하루·사흘·일주일(기본)·한 달.
export const RECENT_DAY_CHOICES = [1, 3, 7, 30] as const;
export const DEFAULT_RECENT_DAYS = 7;
export const MAX_RECENT_DAYS = 30;
// 한 번에 돌려주는 줄 수 상한.
export const MAX_RECENT_LIMIT = 200;
// 창이 열려 있는 동안의 갱신 간격.
export const RECENT_REFRESH_MS = 60_000;
// 지금 자리를 찾는 것은 앞의 이만큼 줄뿐이다(나머지는 "확인 못 함").
export const RECENT_LOCATE_ROWS = 50;
// 위치 찾기의 탐색 상한(폴더 목록 읽기 + 항목 하나하나 — 검색과 같은 셈).
export const RECENT_TRAVERSAL_LIMIT = 1_000;

// 줄이 되는 행위. 내력의 deleted·restored는 줄이 아니라 상태 표시다.
export const RECENT_ACTIONS = ["upload", "edit", "rename", "move"] as const;
export type RecentAction = (typeof RECENT_ACTIONS)[number];

export interface RecentActor {
  // 멤버는 지금 별명(없으면 null — 화면이 "멤버"로 보인다. 실명은 내보내지
  // 않는다). 공개 폴더 손님이면 방문자가 적은 이름이거나 null.
  name: string | null;
  guest: boolean;
}

export interface RecentFileItem {
  layoutKey: string;
  // 지금 이름. 사라졌으면 마지막으로 기록된 이름.
  name: string;
  isFolder: boolean;
  mimeType: string | null;
  // 이 줄(묶음)의 가장 늦은 시각(서버 시각).
  at: string;
  action: RecentAction;
  // 같은 사람이 같은 항목에 잇달아 한 같은 행위를 묶은 수(1 이상).
  count: number;
  actor: RecentActor;
  // true: 지금 데스크에 있다 · false: 사라졌다(휴지통 기록 또는 끝까지 찾아도
  // 없음) · null: 찾지 않았거나(앞 50줄 밖) 탐색 상한에 걸려 확인하지 못했다.
  exists: boolean | null;
  // 지금 자리 — 검색 결과와 같은 꼴(열기·우클릭 메뉴·원래 위치를 그대로 쓴다).
  // 지금 없거나 확인하지 못했으면 null.
  location: StorageSearchResult | null;
}

export interface RecentFilesResponse {
  // 응답 직전의 서버 시각 — 화면이 "3분 전"을 셀 때 브라우저 시계 어긋남을 보정한다.
  now: string;
  days: number;
  items: RecentFileItem[];
  // 확인하지 못한 줄(exists=null)이 있다.
  truncated: boolean;
  // 위치 찾기가 쓴 탐색량(폴더 목록 읽기 + 본 항목 수). 찾을 것이 없으면 0.
  explored: number;
}

export interface RecentQuery {
  days: number;
  limit: number;
}

function parseWhole(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,6}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * ?days=7&limit=200 읽기. days는 1–30일(없으면 7), limit은 1 이상(없으면 200,
 * 200을 넘으면 200으로 자른다). 숫자가 아니거나 범위를 벗어나면 null(400).
 */
export function parseRecentQuery(
  params: Pick<URLSearchParams, "get">,
): RecentQuery | null {
  const days = parseWhole(params.get("days"), DEFAULT_RECENT_DAYS);
  const limit = parseWhole(params.get("limit"), MAX_RECENT_LIMIT);
  if (days === null || days < 1 || days > MAX_RECENT_DAYS) return null;
  if (limit === null || limit < 1) return null;
  return { days, limit: Math.min(limit, MAX_RECENT_LIMIT) };
}

// 줄 — 아직 위치·화면 이름을 모르는 단계. 같은 항목의 잇단 같은 행위(같은 사람)를
// 한 줄로 묶었다.
export interface RecentRow {
  layoutKey: string;
  // 묶음의 가장 늦은 시각(ms).
  at: number;
  action: RecentAction;
  count: number;
  // 기록 당시 이름(공개 폴더 손님이면 방문자가 적은 이름, 없을 수 있다).
  by: string | null;
  // 세션 userId(멤버 명단 id 또는 접속 키 손님 id). 옛 기록에는 없다.
  byId: string | null;
  // 공개 폴더 방문자 업로드(#17 B-4).
  guest: boolean;
}

type RecentEvent = Omit<RecentRow, "layoutKey" | "count">;

function timeOf(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isRecentAction(kind: string): kind is RecentAction {
  return (RECENT_ACTIONS as readonly string[]).includes(kind);
}

function eventsOf(audit: EntryAudit): RecentEvent[] {
  const events: RecentEvent[] = [];
  const uploadedAt = timeOf(audit.uploadedAt);
  if (uploadedAt !== null) {
    events.push({
      at: uploadedAt,
      action: "upload",
      by: audit.uploadedBy ?? null,
      byId: audit.uploadedById ?? null,
      guest: audit.uploadedByGuest === true,
    });
  }
  for (const change of audit.changes ?? []) {
    const at = timeOf(change.at);
    if (at === null || !isRecentAction(change.kind)) continue;
    events.push({
      at,
      action: change.kind,
      by: change.by,
      byId: change.byId ?? null,
      guest: false,
    });
  }
  return events;
}

// 같은 사람인가 — id가 있으면 id로, 옛 기록은 이름으로 견준다.
function actorKey(event: Pick<RecentEvent, "by" | "byId" | "guest">): string {
  if (event.guest) return `guest:${event.by ?? ""}`;
  return event.byId ? `id:${event.byId}` : `name:${event.by ?? ""}`;
}

/**
 * 내력 전체에서 최근 days일의 줄을 시간 역순으로 만든다(자르지 않는다 — 이름
 * 모르는 옛 기록을 거른 뒤 부르는 쪽이 limit을 적용한다). 기간 밖의 일은 먼저
 * 버리고, 한 항목의 내력에서 잇달아 나온 같은 행위·같은 사람을 한 줄로 묶어
 * count로 센다(사이에 다른 행위나 다른 사람이 끼면 새 줄).
 */
export function buildRecentRows(
  entries: Readonly<Record<string, EntryAudit>>,
  options: { now: number; days: number },
): RecentRow[] {
  const since = options.now - options.days * 24 * 60 * 60 * 1000;
  const rows: RecentRow[] = [];
  for (const [layoutKey, audit] of Object.entries(entries)) {
    const events = eventsOf(audit)
      .filter((event) => event.at >= since)
      .sort((left, right) => right.at - left.at);
    let last: RecentRow | null = null;
    for (const event of events) {
      if (
        last &&
        last.action === event.action &&
        actorKey(last) === actorKey(event)
      ) {
        last.count += 1;
        continue;
      }
      last = { layoutKey, ...event, count: 1 };
      rows.push(last);
    }
  }
  // 같은 시각이면 열쇠·행위 순 — 새로 고칠 때마다 줄이 뒤바뀌지 않게.
  const compareText = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  return rows.sort(
    (left, right) =>
      right.at - left.at ||
      compareText(left.layoutKey, right.layoutKey) ||
      compareText(left.action, right.action),
  );
}

/** 내력의 마지막 휴지통 표시가 "deleted"인가(그 뒤 "restored"가 없다). */
export function goneByRecord(audit: EntryAudit | undefined): boolean {
  let latest: { at: number; deleted: boolean } | null = null;
  for (const change of audit?.changes ?? []) {
    if (change.kind !== "deleted" && change.kind !== "restored") continue;
    const at = timeOf(change.at);
    if (at === null || (latest && latest.at >= at)) continue;
    latest = { at, deleted: change.kind === "deleted" };
  }
  return latest?.deleted === true;
}

/**
 * 줄 하나를 응답 항목으로. 지금 자리를 찾았으면 지금 이름·종류를 쓰고, 못
 * 찾았으면 내력의 마지막 이름으로 낸다(exists는 부르는 쪽이 정한다). 이름을
 * 모르는 옛 기록인데 자리도 없으면 버린다(null).
 */
export function recentItem(
  row: RecentRow,
  audit: EntryAudit | undefined,
  location: StorageSearchResult | null,
  exists: boolean | null,
  actor: RecentActor,
): RecentFileItem | null {
  const common = {
    layoutKey: row.layoutKey,
    at: new Date(row.at).toISOString(),
    action: row.action,
    count: row.count,
    actor,
  };
  if (location) {
    return {
      ...common,
      name: location.entry.name,
      isFolder: location.entry.isFolder,
      mimeType: location.entry.mimeType,
      exists: true,
      location,
    };
  }
  const name = audit?.name;
  if (!name) return null;
  return {
    ...common,
    name,
    isFolder: audit?.isFolder === true,
    mimeType: null,
    exists,
    location: null,
  };
}
