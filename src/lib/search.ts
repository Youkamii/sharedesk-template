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

type ListAdapter = Pick<StorageAdapter, "list">;

interface FolderFrame {
  id: string;
  breadcrumbs: FolderCrumb[];
}

interface LocatedScope extends FolderFrame {
  entry: Entry | null;
  parentId: string | null;
  parentBreadcrumbs: FolderCrumb[];
}

class TraversalBudget {
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("검색이 취소되었습니다", "AbortError");
}

function isVisible(entry: Entry): boolean {
  return !entry.name.startsWith(".");
}

function folderKey(entry: Entry): string {
  return entry.layoutKey || entry.id;
}

function pathFrom(breadcrumbs: readonly FolderCrumb[], name: string): string {
  return `/${[...breadcrumbs.slice(1).map((crumb) => crumb.name), name].join("/")}`;
}

async function listFolder(
  adapter: ListAdapter,
  folderId: string,
  budget: TraversalBudget,
  signal: AbortSignal | undefined,
): Promise<Entry[] | null> {
  throwIfAborted(signal);
  if (!budget.take()) return null;
  const entries = await adapter.list(folderId);
  throwIfAborted(signal);
  return entries;
}

async function locateScope(
  adapter: ListAdapter,
  scopeFolderId: string,
  budget: TraversalBudget,
  signal: AbortSignal | undefined,
): Promise<{ scope: LocatedScope | null; complete: boolean }> {
  const rootCrumbs: FolderCrumb[] = [{ id: ROOT_ID, name: "ShareDesk" }];
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

  const queue: FolderFrame[] = [{ id: ROOT_ID, breadcrumbs: rootCrumbs }];
  const visitedIds = new Set<string>([ROOT_ID]);
  const visitedKeys = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    const entries = await listFolder(adapter, parent.id, budget, signal);
    if (!entries) return { scope: null, complete: false };

    for (const entry of entries) {
      throwIfAborted(signal);
      if (!budget.take()) return { scope: null, complete: false };
      if (!isVisible(entry)) continue;

      if (entry.id === scopeFolderId) {
        if (!entry.isFolder) {
          throw new StorageError("BAD_ID", "검색 범위가 폴더가 아닙니다");
        }
        return {
          scope: {
            id: entry.id,
            breadcrumbs: [
              ...parent.breadcrumbs,
              { id: entry.id, name: entry.name },
            ],
            entry,
            parentId: parent.id,
            parentBreadcrumbs: parent.breadcrumbs,
          },
          complete: true,
        };
      }

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

  return { scope: null, complete: true };
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
  const budget = new TraversalBudget(
    limit(options.maxTraversal, SEARCH_TRAVERSAL_LIMIT),
  );
  const needle = query.toLocaleLowerCase("ko-KR");
  const matches = (name: string) =>
    name.toLocaleLowerCase("ko-KR").includes(needle);

  throwIfAborted(options.signal);
  const located = await locateScope(
    adapter,
    scopeFolderId,
    budget,
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
      explored: budget.explored,
    };
  }

  const queue: FolderFrame[] = [located.scope];
  const visitedIds = new Set<string>([located.scope.id]);
  const visitedKeys = new Set<string>(
    located.scope.entry ? [folderKey(located.scope.entry)] : [],
  );

  search: for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    const entries = await listFolder(
      adapter,
      parent.id,
      budget,
      options.signal,
    );
    if (!entries) {
      truncated = true;
      break;
    }

    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (!budget.take()) {
        truncated = true;
        break search;
      }
      if (!isVisible(entry)) continue;
      if (!addResult(entry, parent.id, parent.breadcrumbs)) break search;

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

  return {
    query,
    scopeFolderId,
    results,
    truncated,
    explored: budget.explored,
  };
}
