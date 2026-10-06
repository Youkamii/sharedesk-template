// 안 본 새 파일 NEW 배지(#16 C-2) — 판정·폴더 집계·저장을 맡는 순수 모듈.
//
// 서버 기록은 추가하지 않는다(이슈 계약). 확인 기록은 이 브라우저 localStorage에만 있고,
// 키에 데스크 원점·스페이스·사용자를 넣어 데스크끼리 섞이지 않게 한다(로그아웃 때 모두 지운다).
//
// 시각은 모두 서버 시각이다. 기준은 "그때 본 목록의 최대 modifiedAt"(listStamp)이라 브라우저
// 시계가 몇 시간 어긋나도 판정이 바뀌지 않는다 — 이 파일은 브라우저 시계를 읽지 않는다.
//  - since: 이 브라우저가 이 데스크에서 처음 받은 목록의 최대 modifiedAt. 한 번도 본 적 없는
//    폴더의 기준이라, 처음 온 브라우저에서는 기존 파일이 NEW가 아니다.
//  - seen[폴더 id]: 그 폴더를 보고 있는 동안 받은 목록의 최대 modifiedAt. 목록을 새로 받을 때마다
//    오른다(바탕화면은 10초 머문 뒤부터, 폴더 창은 목록이 뜬 순간부터, 탭이 보이는 동안만 — 화면 쪽 몫).
//  - 화면의 점은 그 자리를 처음 연 순간의 기준으로 그린다(그동안 새로 온 것이 보이게). 저장값만 오른다.
//  - own: 이 브라우저에서 내가 올리거나 고친 파일 id와 그 버전의 modifiedAt. 그 뒤 누가 다시 고쳐
//    modifiedAt이 커지면 다시 NEW 판정을 받는다. 시각을 아직 모르면(직행 업로드) 처음 본 목록에서 채운다.

export const NEW_BADGE_STORAGE_PREFIX = "sharedesk.new-badges.v1";
// 바탕화면을 "본 것"으로 치기까지 머무는 시간(이 뒤부터 목록을 받을 때마다 기준을 올린다).
export const ROOT_SEEN_DELAY_MS = 10_000;
// 폴더 아이콘 배지를 세려고 하위 목록을 다시 받는 간격. 화면의 30초 목록 확인에 얹혀 돈다.
export const NEW_BADGE_REFRESH_MS = 120_000;
// 배지를 세는 폴더 수 상한 — 보이는 순서(바탕화면 → 열린 창)로 앞의 이만큼만 센다.
export const MAX_BADGE_FOLDERS = 24;
// 저장 상한 — 넘치면 오래된 것부터 버린다(배지는 잃어도 되는 꾸밈이다).
export const MAX_SEEN_FOLDERS = 500;
export const MAX_OWN_UPLOADS = 300;

export interface OwnUpload {
  id: string;
  // 내가 올리거나 고친 버전의 modifiedAt(서버 시각). 아직 모르면 null.
  at: number | null;
}

export interface NewBadgeState {
  since: number | null;
  seen: Record<string, number>;
  // 오래된 것이 앞.
  own: OwnUpload[];
}

export interface NewBadgeEntry {
  id: string;
  isFolder: boolean;
  modifiedAt: string | null;
}

export type OwnUploadIndex = ReadonlyMap<string, number | null>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function newBadgeStorageKey(
  origin: string,
  spaceSlug: string | null,
  user: string,
): string {
  return `${NEW_BADGE_STORAGE_PREFIX}|${origin}|${spaceSlug ?? "main"}|${user || "guest"}`;
}

export function emptyNewBadgeState(): NewBadgeState {
  return { since: null, seen: {}, own: [] };
}

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** 저장된 글을 상태로 읽는다. 없거나 깨졌으면 빈 상태다. */
export function parseNewBadgeState(text: string | null): NewBadgeState {
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return emptyNewBadgeState();
  const value = raw as Partial<Record<keyof NewBadgeState, unknown>>;
  const seen: Record<string, number> = {};
  if (value.seen && typeof value.seen === "object") {
    for (const [folderId, at] of Object.entries(value.seen as Record<string, unknown>)) {
      const time = finiteTime(at);
      if (folderId && time !== null) seen[folderId] = time;
    }
  }
  const own: OwnUpload[] = [];
  if (Array.isArray(value.own)) {
    for (const item of value.own as unknown[]) {
      const record = item as Partial<OwnUpload> | null;
      if (typeof record?.id === "string" && record.id) {
        own.push({ id: record.id, at: finiteTime(record.at) });
      }
    }
  }
  return capNewBadgeState({ since: finiteTime(value.since), seen, own });
}

/** 상한을 넘은 기록을 버린다 — 확인 기록은 오래된 것부터, 내 업로드는 앞에서부터. */
export function capNewBadgeState(state: NewBadgeState): NewBadgeState {
  let seen = state.seen;
  const folders = Object.keys(seen);
  if (folders.length > MAX_SEEN_FOLDERS) {
    const kept = folders.sort((a, b) => seen[b] - seen[a]).slice(0, MAX_SEEN_FOLDERS);
    seen = Object.fromEntries(kept.map((folderId) => [folderId, state.seen[folderId]]));
  }
  const own =
    state.own.length > MAX_OWN_UPLOADS
      ? state.own.slice(state.own.length - MAX_OWN_UPLOADS)
      : state.own;
  return seen === state.seen && own === state.own ? state : { ...state, seen, own };
}

/** 이 브라우저의 localStorage. 접근 자체가 막힌 브라우저(사생활 보호 등)에서는 null. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface NewBadgeStore {
  read(): NewBadgeState;
  /** 저장소의 최신 값(다른 탭이 쓴 것 포함) 위에 바꾸고 저장한다. 바뀐 게 없으면 같은 객체. */
  update(change: (state: NewBadgeState) => NewBadgeState): NewBadgeState;
}

/**
 * 저장소 열기 → 읽기 → 바꾸기 → 쓰기를 한곳에 모은다. 저장소가 없거나 막혀 있으면
 * 이 탭의 메모리에서만 기억한다. 같은 내용이면 같은 객체를 돌려줘 화면이 다시 그려지지 않는다.
 */
export function openNewBadgeStore(
  key: string,
  storage: StorageLike | null = browserStorage(),
): NewBadgeStore {
  let cachedText: string | null = null;
  let cached = emptyNewBadgeState();
  const read = () => {
    let text = cachedText;
    if (storage) {
      try {
        text = storage.getItem(key);
      } catch {
        text = cachedText;
      }
    }
    if (text !== cachedText) {
      cached = parseNewBadgeState(text);
      cachedText = text;
    }
    return cached;
  };
  return {
    read,
    update(change) {
      const base = read();
      const next = capNewBadgeState(change(base));
      if (next === base) return base;
      const text = JSON.stringify(next);
      if (text === cachedText) return base;
      try {
        storage?.setItem(key, text);
      } catch {
        // 용량 초과·차단: 배지는 꾸밈이라 실패해도 본 작업을 막지 않는다(이 탭에서는 기억).
      }
      cachedText = text;
      cached = next;
      return next;
    },
  };
}

/** 로그아웃 때 이 브라우저의 NEW 배지 기록(모든 데스크·사용자)을 지운다. 지운 개수를 돌려준다. */
export function clearNewBadgeStores(
  storage: Pick<Storage, "length" | "key" | "removeItem"> | null = browserStorage(),
): number {
  if (!storage) return 0;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${NEW_BADGE_STORAGE_PREFIX}|`)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return keys.length;
  } catch {
    return 0;
  }
}

export function entryTime(entry: Pick<NewBadgeEntry, "modifiedAt"> | null | undefined): number | null {
  if (!entry?.modifiedAt) return null;
  const time = Date.parse(entry.modifiedAt);
  return Number.isFinite(time) ? time : null;
}

/** 목록의 도장 — 그 목록에서 본 가장 늦은 modifiedAt(서버 시각). 시각이 하나도 없으면 null. */
export function listStamp(entries: readonly Pick<NewBadgeEntry, "modifiedAt">[]): number | null {
  let stamp: number | null = null;
  for (const entry of entries) {
    const time = entryTime(entry);
    if (time !== null && (stamp === null || time > stamp)) stamp = time;
  }
  return stamp;
}

/** 시각을 모르던 내 업로드는 목록에서 처음 본 modifiedAt을 내 버전의 시각으로 삼는다. */
export function settleOwnUploads(
  state: NewBadgeState,
  entries: readonly NewBadgeEntry[],
): NewBadgeState {
  if (!state.own.some((record) => record.at === null)) return state;
  const times = new Map(entries.map((entry) => [entry.id, entryTime(entry)]));
  let changed = false;
  const own = state.own.map((record) => {
    const time = record.at === null ? times.get(record.id) : undefined;
    if (time === undefined || time === null) return record;
    changed = true;
    return { id: record.id, at: time };
  });
  return changed ? { ...state, own } : state;
}

/** 받은 목록을 기록에 비춘다 — 처음이면 since를 정하고(빈 데스크면 0), 내 업로드 시각을 채운다. */
export function observeList(
  state: NewBadgeState,
  entries: readonly NewBadgeEntry[],
): NewBadgeState {
  const settled = settleOwnUploads(state, entries);
  if (settled.since !== null) return settled;
  return { ...settled, since: listStamp(entries) ?? 0 };
}

/** 폴더를 본 것으로 남긴다 — 확인 기준을 그 목록의 도장까지 올린다(내려가지 않는다). */
export function markFolderSeen(
  state: NewBadgeState,
  folderId: string,
  entries: readonly Pick<NewBadgeEntry, "modifiedAt">[],
): NewBadgeState {
  const stamp = listStamp(entries);
  const previous = state.seen[folderId];
  if (stamp === null || (previous !== undefined && previous >= stamp)) return state;
  const seen = { ...state.seen };
  delete seen[folderId];
  seen[folderId] = stamp;
  return { ...state, seen };
}

/** 폴더의 판정 기준 — 본 기록과 처음 온 기준 중 늦은 것. 아직 아무 목록도 못 봤으면 null. */
export function folderSeenAt(state: NewBadgeState, folderId: string): number | null {
  const seen = state.seen[folderId];
  if (seen === undefined) return state.since;
  return state.since === null ? seen : Math.max(seen, state.since);
}

/** 내가 올리거나 고친 파일을 기억한다(같은 파일이면 새 시각으로 바꿔 맨 뒤로). */
export function rememberOwnUpload(
  state: NewBadgeState,
  id: string,
  at: number | null,
): NewBadgeState {
  if (!id) return state;
  const existing = state.own.find((record) => record.id === id);
  if (existing && existing.at === at && state.own.at(-1) === existing) return state;
  return {
    ...state,
    own: [...state.own.filter((record) => record.id !== id), { id, at }],
  };
}

export function ownUploadIndex(state: NewBadgeState | null): OwnUploadIndex {
  return new Map((state?.own ?? []).map((record) => [record.id, record.at]));
}

/**
 * 파일이 기준 뒤에 올라왔거나 바뀌었으면 NEW. 폴더는 점 대신 배지로 센다.
 * 내가 올린 버전이면 NEW가 아니고, 그 뒤 누가 다시 고친 것이면 보통 파일처럼 판정한다.
 */
export function isNewEntry(
  entry: NewBadgeEntry,
  baseline: number | null,
  own: OwnUploadIndex,
): boolean {
  if (entry.isFolder || baseline === null) return false;
  const time = entryTime(entry);
  if (time === null || time <= baseline) return false;
  if (!own.has(entry.id)) return true;
  const mine = own.get(entry.id);
  return mine !== null && mine !== undefined && time > mine;
}

/** 폴더 집계 — 바로 아래 파일 중 NEW인 것의 수(하위 폴더 속은 세지 않는다). */
export function countNewEntries(
  children: readonly NewBadgeEntry[],
  baseline: number | null,
  own: OwnUploadIndex,
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

/** 배지를 셀 폴더 — 보이는 순서로, 창으로 열려 있는 폴더(창 목록을 쓴다)는 빼고 앞의 limit개. */
export function badgeFolders(
  candidates: readonly string[],
  openFolders: ReadonlySet<string> = new Set(),
  limit = MAX_BADGE_FOLDERS,
): string[] {
  return [...new Set(candidates)]
    .filter((folderId) => !openFolders.has(folderId))
    .slice(0, Math.max(0, limit));
}

// 30초 확인의 타이머 오차 — 4번째 확인(120초)이 몇 ms 이르게 와도 그 차례에 다시 센다.
const REFRESH_SLACK_MS = 5_000;

/** 그중 다시 셀 때가 된 폴더 — 한 번도 안 셌거나 refreshMs가 지난 것(시각은 이 브라우저끼리 비교). */
export function foldersDueForCount(
  folderIds: readonly string[],
  fetchedAt: Readonly<Record<string, number>>,
  now: number,
  refreshMs = NEW_BADGE_REFRESH_MS,
): string[] {
  return folderIds.filter((folderId) => {
    const at = fetchedAt[folderId];
    return at === undefined || now - at >= refreshMs - REFRESH_SLACK_MS;
  });
}

/** 대상에서 빠진 폴더의 캐시를 버린다. 버릴 게 없으면 같은 객체. */
export function pruneBadgeCache<T>(
  cache: Readonly<Record<string, T>>,
  keep: readonly string[],
): Record<string, T> {
  const wanted = new Set(keep);
  const stale = Object.keys(cache).filter((folderId) => !wanted.has(folderId));
  if (stale.length === 0) return cache as Record<string, T>;
  const next = { ...cache };
  for (const folderId of stale) delete next[folderId];
  return next;
}
