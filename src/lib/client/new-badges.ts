// 안 본 새 파일 NEW 배지(#16 C-2) — 판정·폴더 집계·저장 읽기/쓰기만 하는 순수 모듈.
//
// 서버 기록은 추가하지 않는다(이슈 계약). "마지막으로 열어 본 시각"은 이 브라우저의
// localStorage에만 있고, 키에 데스크 원점·스페이스·사용자를 넣어 데스크끼리 섞이지 않게 한다.
//
// 규칙 하나: 폴더를 "열어 목록이 뜬 순간"이 그 폴더의 확인 시각이다.
//  - 폴더 창: 목록이 처음 뜨면 바로 그 시각을 저장한다(→ 바깥 폴더 아이콘의 배지가 사라진다).
//    창 안의 NEW 점은 연 순간의 이전 기준으로 계속 보여 준다(무엇이 새로 왔는지 보이게).
//  - 바탕화면(루트): 데스크를 띄우기만 해도 열리므로, 첫 목록이 뜬 뒤 10초 머물렀을 때 저장한다.
//  - 한 번도 열지 않은 폴더는 이 브라우저가 데스크를 처음 본 시각(since)을 기준으로 삼는다.
// 판정 시각은 entry.modifiedAt(올리거나 고친 시각)이다. 내가 이 브라우저에서 올린 파일은
// 목록에 올린 사람 정보가 없으므로 업로드 응답의 id를 기억해 두었다가 뺀다.

export const NEW_BADGE_STORAGE_PREFIX = "sharedesk.new-badges.v1";
// 루트를 "본 것"으로 치기까지 머무는 시간.
export const ROOT_SEEN_DELAY_MS = 10_000;
// 폴더 아이콘 배지를 세려고 하위 목록을 다시 받는 간격(보이는 동안만).
export const NEW_BADGE_REFRESH_MS = 120_000;
// 배지를 세는 폴더 수 상한 — 폴더가 많은 데스크에서 목록 요청이 불어나지 않게.
// 화면에 보이는 순서(바탕화면 → 열린 창)로 앞의 이만큼만 센다. 2분마다 최대 이만큼 요청한다.
export const MAX_BADGE_FOLDERS = 24;
// 저장 상한 — 넘치면 오래된 것부터 버린다(배지는 잃어도 되는 꾸밈이다).
export const MAX_SEEN_FOLDERS = 500;
export const MAX_OWN_UPLOADS = 300;

export interface NewBadgeState {
  // 이 브라우저가 이 데스크를 처음 본 시각(ms). 한 번도 연 적 없는 폴더의 기준.
  since: number;
  // 폴더 id → 마지막으로 열어 본 시각(ms). 루트는 "root".
  seen: Record<string, number>;
  // 이 브라우저에서 내가 올린 파일 id(오래된 것이 앞).
  own: string[];
}

export interface NewBadgeEntry {
  id: string;
  isFolder: boolean;
  modifiedAt: string | null;
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function newBadgeStorageKey(
  origin: string,
  spaceSlug: string | null,
  user: string,
): string {
  return `${NEW_BADGE_STORAGE_PREFIX}|${origin}|${spaceSlug ?? "main"}|${user || "guest"}`;
}

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function emptyNewBadgeState(now: number): NewBadgeState {
  return { since: now, seen: {}, own: [] };
}

/** 저장된 값을 읽는다. 없거나 깨졌으면 지금을 since로 하는 빈 상태다. */
export function readNewBadgeState(
  storage: ReadableStorage | null,
  key: string,
  now: number,
): NewBadgeState {
  let raw: unknown = null;
  try {
    const text = storage?.getItem(key);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const value = raw as Partial<Record<keyof NewBadgeState, unknown>> | null;
  const since = finiteTime(value?.since);
  if (!value || since === null) return emptyNewBadgeState(now);
  const seen: Record<string, number> = {};
  if (value.seen && typeof value.seen === "object") {
    for (const [folderId, at] of Object.entries(
      value.seen as Record<string, unknown>,
    )) {
      const time = finiteTime(at);
      if (folderId && time !== null) seen[folderId] = time;
    }
  }
  const own = Array.isArray(value.own)
    ? value.own.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  return capNewBadgeState({ since, seen, own });
}

/** 상한을 넘은 기록을 버린다 — 확인 시각은 오래된 것부터, 내 업로드는 앞에서부터. */
export function capNewBadgeState(state: NewBadgeState): NewBadgeState {
  let seen = state.seen;
  const folders = Object.keys(seen);
  if (folders.length > MAX_SEEN_FOLDERS) {
    const kept = folders
      .sort((a, b) => seen[b] - seen[a])
      .slice(0, MAX_SEEN_FOLDERS);
    seen = Object.fromEntries(kept.map((folderId) => [folderId, state.seen[folderId]]));
  }
  const own =
    state.own.length > MAX_OWN_UPLOADS
      ? state.own.slice(state.own.length - MAX_OWN_UPLOADS)
      : state.own;
  return seen === state.seen && own === state.own
    ? state
    : { since: state.since, seen, own };
}

/** 저장한다. 저장소가 막힌 브라우저에서는 조용히 넘어간다(이번 탭에서만 유지). */
export function writeNewBadgeState(
  storage: WritableStorage | null,
  key: string,
  state: NewBadgeState,
): void {
  try {
    storage?.setItem(key, JSON.stringify(capNewBadgeState(state)));
  } catch {
    // 용량 초과·차단: 배지는 꾸밈이라 실패해도 본 작업을 막지 않는다.
  }
}

/** 폴더의 판정 기준 시각 — 열어 본 적이 없으면 데스크를 처음 본 시각. */
export function folderSeenAt(state: NewBadgeState, folderId: string): number {
  return state.seen[folderId] ?? state.since;
}

/** 폴더를 열어 본 시각을 남긴다. 시계가 뒤로 가도 기준이 거꾸로 가지 않게 큰 값을 지킨다. */
export function markFolderSeen(
  state: NewBadgeState,
  folderId: string,
  at: number,
): NewBadgeState {
  const previous = state.seen[folderId];
  if (previous !== undefined && previous >= at) return state;
  // 다시 넣어 맨 뒤로 — 넘침 처리는 시각 순이라 순서는 상관없지만 읽기 쉽게 둔다.
  const seen = { ...state.seen };
  delete seen[folderId];
  seen[folderId] = at;
  return capNewBadgeState({ ...state, seen });
}

/** 이 브라우저에서 내가 올린 파일 id를 기억한다 — 내 파일은 NEW가 아니다. */
export function rememberOwnUpload(state: NewBadgeState, id: string): NewBadgeState {
  if (!id || state.own.includes(id)) return state;
  return capNewBadgeState({ ...state, own: [...state.own, id] });
}

export function entryTime(entry: Pick<NewBadgeEntry, "modifiedAt">): number | null {
  if (!entry.modifiedAt) return null;
  const time = Date.parse(entry.modifiedAt);
  return Number.isFinite(time) ? time : null;
}

/** 파일이 기준 시각 뒤에 올라왔거나 바뀌었고, 내가 올린 것이 아니면 NEW. 폴더는 점 대신 배지. */
export function isNewEntry(
  entry: NewBadgeEntry,
  baseline: number | null,
  own: ReadonlySet<string>,
): boolean {
  if (entry.isFolder || baseline === null) return false;
  const time = entryTime(entry);
  return time !== null && time > baseline && !own.has(entry.id);
}

/** 폴더 집계 — 바로 아래 파일 중 NEW인 것의 수(하위 폴더 속은 세지 않는다). */
export function countNewEntries(
  children: readonly NewBadgeEntry[],
  baseline: number | null,
  own: ReadonlySet<string>,
): number {
  let count = 0;
  for (const child of children) {
    if (isNewEntry(child, baseline, own)) count += 1;
  }
  return count;
}

/** 배지 글자 — 0이면 그리지 않고, 10개부터는 "9+". */
export function newBadgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? "9+" : String(Math.floor(count));
}

/** 배지를 셀 폴더 — 보이는 순서로 앞의 limit개만 대상으로 삼는다(나머지는 배지 없음). */
export function badgeFolders(
  folderIds: readonly string[],
  limit = MAX_BADGE_FOLDERS,
): string[] {
  return [...new Set(folderIds)].slice(0, Math.max(0, limit));
}

/** 그중 다시 셀 때가 된 폴더 — 한 번도 안 셌거나 refreshMs가 지난 것. */
export function foldersDueForCount(
  folderIds: readonly string[],
  fetchedAt: Readonly<Record<string, number>>,
  now: number,
  limit = MAX_BADGE_FOLDERS,
  refreshMs = NEW_BADGE_REFRESH_MS,
): string[] {
  return badgeFolders(folderIds, limit).filter((folderId) => {
    const at = fetchedAt[folderId];
    return at === undefined || now - at >= refreshMs;
  });
}
