import type { EntryAudit, EntryChangeKind } from "@/lib/entry-audit";
import type { FolderCrumb } from "@/lib/folder-path";
import type { Entry } from "@/lib/storage/types";

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
// 접속 키 손님의 세션 userId 머리(auth.ts resolveSession) — 손님으로 보인다.
export const KEY_GUEST_ID_PREFIX = "key:";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RecentAction = "upload" | EntryChangeKind;

export interface RecentActor {
  // 멤버는 지금 화면 이름(별명, 없으면 이름). 손님이면 공개 폴더 방문자가
  // 적은 이름이거나 null — 화면이 "손님 · 이름"/"손님"으로 바꿔 보인다.
  name: string | null;
  guest: boolean;
}

export interface RecentFileItem {
  layoutKey: string;
  // 지금 id. 사라졌거나 위치를 확인하지 못했으면 null.
  id: string | null;
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
  // true: 지금 데스크에 있다 · false: 사라졌다(삭제·휴지통) ·
  // null: 위치 찾기가 탐색 상한에 걸려 확인하지 못했다.
  exists: boolean | null;
  // 지금 항목 그대로(열기·미리보기·메뉴용). 지금 없으면 null.
  entry: Entry | null;
  parentId: string | null;
  // 루트부터 부모 폴더까지(루트 포함). 지금 없으면 빈 배열.
  path: FolderCrumb[];
}

export interface RecentFilesResponse {
  // 서버의 지금 — 화면이 "3분 전"을 셀 때 브라우저 시계 어긋남을 보정한다.
  now: string;
  days: number;
  items: RecentFileItem[];
  // 위치 찾기가 탐색 상한에 걸렸다(exists가 null인 줄이 있을 수 있다).
  truncated: boolean;
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
  // 세션 userId(멤버 명단 id 또는 "key:…"). 옛 기록에는 없다.
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
    if (at === null) continue;
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
 * 내력 전체에서 최근 days일의 줄을 시간 역순으로 만든다(상한 limit줄).
 * 기간 밖의 일은 먼저 버리고, 한 항목의 내력에서 잇달아 나온 같은 행위·같은
 * 사람을 한 줄로 묶어 count로 센다(사이에 다른 행위나 다른 사람이 끼면 새 줄).
 */
export function buildRecentRows(
  entries: Readonly<Record<string, EntryAudit>>,
  options: { now: number; days: number; limit: number },
): RecentRow[] {
  const since = options.now - options.days * DAY_MS;
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
  return rows
    .sort(
      (left, right) =>
        right.at - left.at ||
        compareText(left.layoutKey, right.layoutKey) ||
        compareText(left.action, right.action),
    )
    .slice(0, Math.max(0, options.limit));
}

/**
 * 행위자 표시 — 공개 폴더 손님·접속 키 손님은 손님, 멤버는 지금 화면 이름
 * (displayNames: 명단 id → 별명 또는 이름). 명단에서 못 찾은 옛 기록은 기록 당시 이름.
 */
export function recentActor(
  row: Pick<RecentRow, "by" | "byId" | "guest">,
  displayNames: ReadonlyMap<string, string>,
): RecentActor {
  if (row.guest) return { name: row.by, guest: true };
  if (row.byId?.startsWith(KEY_GUEST_ID_PREFIX)) {
    return { name: null, guest: true };
  }
  const current = row.byId ? displayNames.get(row.byId) : undefined;
  return { name: current ?? row.by, guest: false };
}

// 지금 데스크에서 찾은 자리.
export interface RecentLocation {
  entry: Entry;
  parentId: string;
  path: FolderCrumb[];
}

/**
 * 줄 하나를 응답 항목으로. 지금 자리를 찾았으면 지금 이름·종류·경로를 쓰고,
 * 못 찾았으면 내력의 마지막 이름으로 "사라짐"(탐색을 끝까지 했을 때) 또는
 * "확인 못 함"(상한에 걸렸을 때)으로 낸다. 이름을 모르는 옛 기록은 버린다(null).
 */
export function recentItem(
  row: RecentRow,
  audit: EntryAudit | undefined,
  location: RecentLocation | undefined,
  searchedEverywhere: boolean,
  displayNames: ReadonlyMap<string, string>,
): RecentFileItem | null {
  const common = {
    layoutKey: row.layoutKey,
    at: new Date(row.at).toISOString(),
    action: row.action,
    count: row.count,
    actor: recentActor(row, displayNames),
  };
  if (location) {
    return {
      ...common,
      id: location.entry.id,
      name: location.entry.name,
      isFolder: location.entry.isFolder,
      mimeType: location.entry.mimeType,
      exists: true,
      entry: location.entry,
      parentId: location.parentId,
      path: location.path,
    };
  }
  const name = audit?.name;
  if (!name) return null;
  return {
    ...common,
    id: null,
    name,
    isFolder: audit?.isFolder === true,
    mimeType: null,
    exists: searchedEverywhere ? false : null,
    entry: null,
    parentId: null,
    path: [],
  };
}
