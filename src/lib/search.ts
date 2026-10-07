import { getAdapter } from "@/lib/storage";
import {
  ROOT_ID,
  StorageError,
  type Entry,
  type StorageAdapter,
} from "@/lib/storage/types";
import type { FolderCrumb } from "@/lib/folder-path";

export const SEARCH_RESULT_LIMIT = 200;
export const SEARCH_TRAVERSAL_LIMIT = 5_000;

// Finding a server-verified scope is separate from searching inside it. Large
// sibling lists must not spend the caller's search budget, but scope discovery
// still needs a hard ceiling so malformed trees cannot grow the queue forever.
const SEARCH_SCOPE_TRAVERSAL_LIMIT = 25_000;

const MAX_QUERY_LENGTH = 200;
const MAX_FOLDER_ID_LENGTH = 1_024;

export interface StorageSearchResult {
  entry: Entry;
  parentId: string;
  breadcrumbs: FolderCrumb[];
  path: string;
}

export interface StorageSearchResponse {
  query: string;
  scopeFolderId: string;
  results: StorageSearchResult[];
  truncated: boolean;
  explored: number;
}

interface SearchOptions {
  signal?: AbortSignal;
  maxResults?: number;
  maxTraversal?: number;
}

export type ListAdapter = Pick<StorageAdapter, "list">;

export interface FolderFrame {
  id: string;
  breadcrumbs: FolderCrumb[];
}

// 루트 폴더 칸 — 경로(breadcrumbs)의 첫 칸.
export const ROOT_CRUMB: FolderCrumb = { id: ROOT_ID, name: "ShareDesk" };

interface LocatedScope extends FolderFrame {
  entry: Entry | null;
  parentId: string | null;
  parentBreadcrumbs: FolderCrumb[];
}

// 폴더 목록 읽기와 항목 하나하나가 예산을 한 칸씩 쓴다(숨김 항목도 센다).
export class TraversalBudget {
  explored = 0;

  constructor(readonly limit: number) {}

  take(): boolean {
    if (this.explored >= this.limit) return false;
    this.explored += 1;
    return true;
  }
}

function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StorageError("BAD_ID", "잘못된 검색 제한값입니다");
  }
  return Math.min(value, maximum);
}

function cleanQuery(raw: string): string {
  const query = raw.trim();
  if (!query || query.length > MAX_QUERY_LENGTH || query.includes("\0")) {
    throw new StorageError("BAD_NAME", "검색어를 입력해 주세요");
  }
  return query;
}

function cleanFolderId(raw: string): string {
  if (!raw || raw.length > MAX_FOLDER_ID_LENGTH || raw.includes("\0")) {
    throw new StorageError("BAD_ID", "잘못된 검색 범위입니다");
  }
  return raw;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("검색이 취소되었습니다", "AbortError");
}

export function isVisible(entry: Entry): boolean {
  return !entry.name.startsWith(".");
}

export function folderKey(entry: Entry): string {
  return entry.layoutKey || entry.id;
}

export function pathFrom(
  breadcrumbs: readonly FolderCrumb[],
  name: string,
): string {
  return `/${[...breadcrumbs.slice(1).map((crumb) => crumb.name), name].join("/")}`;
}

export type WalkOutcome = "complete" | "stopped" | "truncated";

/**
 * start 폴더부터 너비 우선으로 폴더를 내려가며 보이는 항목마다 visit을 부른다
 * (검색·검색 범위 찾기·최근 파일 위치 찾기가 함께 쓴다).
 * - 예산: 폴더 목록 읽기 한 번과 항목 하나(숨김 포함)가 한 칸씩. 다 쓰면 "truncated".
 * - visit이 false를 돌려주면 그 자리에서 멈춘다("stopped").
 * - 같은 폴더(id 또는 layoutKey)는 두 번 내려가지 않는다. startKey는 시작 폴더의 열쇠.
 * - 목록 읽기 실패는 그대로 던진다. 취소 신호는 읽기 앞뒤와 항목마다 본다.
 * - concurrency: 폴더 목록을 한 번에 몇 개씩 읽을지(기본 1 — 하나씩 차례로).
 */
export async function walkFolders(
  adapter: ListAdapter,
  start: FolderFrame,
  startKey: string | undefined,
  budget: TraversalBudget,
  signal: AbortSignal | undefined,
  visit: (entry: Entry, parent: FolderFrame) => boolean,
  options: { concurrency?: number } = {},
): Promise<WalkOutcome> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const queue: FolderFrame[] = [start];
  const visitedIds = new Set<string>([start.id]);
  const visitedKeys = new Set<string>(startKey ? [startKey] : []);

  for (let index = 0; index < queue.length; ) {
    const chunk = queue.slice(index, index + concurrency);
    index += chunk.length;
    throwIfAborted(signal);
    let granted = 0;
    while (granted < chunk.length && budget.take()) granted += 1;
    const listed = await Promise.all(
      chunk.slice(0, granted).map((frame) => adapter.list(frame.id)),
    );
    throwIfAborted(signal);

    for (let position = 0; position < granted; position += 1) {
      const parent = chunk[position];
      for (const entry of listed[position]) {
        throwIfAborted(signal);
        if (!budget.take()) return "truncated";
        if (!isVisible(entry)) continue;
        if (!visit(entry, parent)) return "stopped";

        if (!entry.isFolder) continue;
        const key = folderKey(entry);
        if (visitedIds.has(entry.id) || visitedKeys.has(key)) continue;
        visitedIds.add(entry.id);
        visitedKeys.add(key);
        queue.push({
          id: entry.id,
          breadcrumbs: [
            ...parent.breadcrumbs,
            { id: entry.id, name: entry.name },
          ],
        });
      }
    }
    if (granted < chunk.length) return "truncated";
  }
  return "complete";
}

async function locateScope(
  adapter: ListAdapter,
  scopeFolderId: string,
  budget: TraversalBudget,
  signal: AbortSignal | undefined,
): Promise<{ scope: LocatedScope | null; complete: boolean }> {
  const rootCrumbs: FolderCrumb[] = [ROOT_CRUMB];
  if (scopeFolderId === ROOT_ID) {
    return {
      scope: {
        id: ROOT_ID,
        breadcrumbs: rootCrumbs,
        entry: null,
        parentId: null,
        parentBreadcrumbs: [],
      },
      complete: true,
    };
  }

  let scope: LocatedScope | null = null;
  const outcome = await walkFolders(
    adapter,
    { id: ROOT_ID, breadcrumbs: rootCrumbs },
    undefined,
    budget,
    signal,
    (entry, parent) => {
      if (entry.id !== scopeFolderId) return true;
      if (!entry.isFolder) {
        throw new StorageError("BAD_ID", "검색 범위가 폴더가 아닙니다");
      }
      scope = {
        id: entry.id,
        breadcrumbs: [...parent.breadcrumbs, { id: entry.id, name: entry.name }],
        entry,
        parentId: parent.id,
        parentBreadcrumbs: parent.breadcrumbs,
      };
      return false;
    },
  );
  if (outcome === "stopped") return { scope, complete: true };
  return { scope: null, complete: outcome === "complete" };
}

export async function searchStorage(
  rawQuery: string,
  rawScopeFolderId = ROOT_ID,
  adapter: ListAdapter = getAdapter(),
  options: SearchOptions = {},
): Promise<StorageSearchResponse> {
  const query = cleanQuery(rawQuery);
  const scopeFolderId = cleanFolderId(rawScopeFolderId);
  const maxResults = limit(options.maxResults, SEARCH_RESULT_LIMIT);
  const searchBudget = new TraversalBudget(
    limit(options.maxTraversal, SEARCH_TRAVERSAL_LIMIT),
  );
  const scopeBudget = new TraversalBudget(SEARCH_SCOPE_TRAVERSAL_LIMIT);
  const needle = query.toLocaleLowerCase("ko-KR");
  const matches = (name: string) =>
    name.toLocaleLowerCase("ko-KR").includes(needle);

  throwIfAborted(options.signal);
  const located = await locateScope(
    adapter,
    scopeFolderId,
    scopeBudget,
    options.signal,
  );
  if (!located.complete) {
    throw new StorageError(
      "BAD_ID",
      "검색 범위를 확인하기 전에 탐색 제한에 도달했습니다",
    );
  }
  if (!located.scope) {
    throw new StorageError("NOT_FOUND", "검색 범위가 ShareDesk 안에 없습니다");
  }

  const results: StorageSearchResult[] = [];
  let truncated = false;
  const addResult = (
    entry: Entry,
    parentId: string,
    breadcrumbs: FolderCrumb[],
  ): boolean => {
    if (!matches(entry.name)) return true;
    if (results.length >= maxResults) {
      truncated = true;
      return false;
    }
    results.push({
      entry,
      parentId,
      breadcrumbs,
      path: pathFrom(breadcrumbs, entry.name),
    });
    return true;
  };

  if (
    located.scope.entry &&
    located.scope.parentId &&
    !addResult(
      located.scope.entry,
      located.scope.parentId,
      located.scope.parentBreadcrumbs,
    )
  ) {
    return {
      query,
      scopeFolderId,
      results,
      truncated,
      explored: searchBudget.explored,
    };
  }

  const outcome = await walkFolders(
    adapter,
    located.scope,
    located.scope.entry ? folderKey(located.scope.entry) : undefined,
    searchBudget,
    options.signal,
    (entry, parent) => addResult(entry, parent.id, parent.breadcrumbs),
  );
  if (outcome === "truncated") truncated = true;

  return {
    query,
    scopeFolderId,
    results,
    truncated,
    explored: searchBudget.explored,
  };
}
