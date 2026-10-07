import { listEntryAudits } from "@/lib/entry-audit";
import type { FolderCrumb } from "@/lib/folder-path";
import {
  buildRecentRows,
  KEY_GUEST_ID_PREFIX,
  recentItem,
  type RecentFileItem,
  type RecentFilesResponse,
  type RecentLocation,
  type RecentQuery,
  type RecentRow,
} from "@/lib/recent-files";
import { runWithSpace } from "@/lib/space-store";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID, type StorageAdapter } from "@/lib/storage/types";
import { listUsers } from "@/lib/users";

// 최근 파일(#16 C-1)의 서버 쪽 — 내력 읽기 → 줄 만들기 → 지금 자리 찾기 →
// 화면 이름 붙이기. 모든 저장소 접근은 호출한 요청의 스페이스 문맥 안에서
// 일어난다(러너가 세운다) — 내력 파일도, 위치를 찾는 목록도 그 스페이스 것이다.

// 위치 찾기의 탐색 상한(목록 읽기 + 항목 하나하나를 센다) — 검색과 같은 크기.
export const RECENT_TRAVERSAL_LIMIT = 5_000;
// 폴더 목록을 동시에 몇 개까지 읽을지(drive는 폴더 하나가 왕복 한 번이다).
const LIST_CONCURRENCY = 4;

type ListAdapter = Pick<StorageAdapter, "list">;

interface FolderFrame {
  id: string;
  path: FolderCrumb[];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("요청이 취소되었습니다", "AbortError");
}

/**
 * layoutKey들의 지금 자리를 루트부터 너비 우선으로 찾는다. 다 찾으면 바로
 * 멈추고, 탐색 상한에 걸리거나 도중에 폴더를 읽지 못하면 complete=false —
 * 그때 못 찾은 항목은 "사라짐"이 아니라 "확인 못 함"이다. 점(.)으로 시작하는
 * 내부 항목은 보지 않는다(검색과 같은 규칙).
 */
export async function locateByLayoutKey(
  wanted: ReadonlySet<string>,
  adapter: ListAdapter = getAdapter(),
  options: { maxTraversal?: number; signal?: AbortSignal } = {},
): Promise<{ found: Map<string, RecentLocation>; complete: boolean }> {
  const found = new Map<string, RecentLocation>();
  if (wanted.size === 0) return { found, complete: true };
  let budget = options.maxTraversal ?? RECENT_TRAVERSAL_LIMIT;
  let complete = true;
  const visitedIds = new Set<string>([ROOT_ID]);
  const visitedKeys = new Set<string>();
  let level: FolderFrame[] = [
    { id: ROOT_ID, path: [{ id: ROOT_ID, name: "ShareDesk" }] },
  ];

  while (level.length > 0) {
    const next: FolderFrame[] = [];
    for (let index = 0; index < level.length; index += LIST_CONCURRENCY) {
      throwIfAborted(options.signal);
      const chunk = level.slice(index, index + LIST_CONCURRENCY);
      if (budget < chunk.length) return { found, complete: false };
      budget -= chunk.length;
      const listed = await Promise.all(
        chunk.map(async (frame) => {
          try {
            return { frame, entries: await adapter.list(frame.id) };
          } catch {
            // 도는 사이 폴더가 지워졌거나 읽지 못했다 — 나머지는 계속 찾되
            // 못 찾은 항목을 "사라짐"으로 단정하지 않는다.
            complete = false;
            return { frame, entries: [] };
          }
        }),
      );
      throwIfAborted(options.signal);
      for (const { frame, entries } of listed) {
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          if (budget <= 0) return { found, complete: false };
          budget -= 1;
          if (wanted.has(entry.layoutKey) && !found.has(entry.layoutKey)) {
            found.set(entry.layoutKey, {
              entry,
              parentId: frame.id,
              path: frame.path,
            });
          }
          if (!entry.isFolder) continue;
          const key = entry.layoutKey || entry.id;
          if (visitedIds.has(entry.id) || visitedKeys.has(key)) continue;
          visitedIds.add(entry.id);
          visitedKeys.add(key);
          next.push({
            id: entry.id,
            path: [...frame.path, { id: entry.id, name: entry.name }],
          });
        }
      }
      if (found.size === wanted.size) return { found, complete: true };
    }
    level = next;
  }
  return { found, complete };
}

// 멤버의 지금 화면 이름(별명, 없으면 이름). 명단의 진실 원천은 기본 데스크라
// 어느 스페이스 문맥에서 불러도 기본 문맥에서 읽는다(users.resolveDisplayName과
// 같은 규칙). 명단을 못 읽으면 기록 당시 이름으로 물러선다.
async function memberDisplayNames(
  rows: readonly RecentRow[],
): Promise<Map<string, string>> {
  const ids = new Set(
    rows.flatMap((row) =>
      row.byId && !row.guest && !row.byId.startsWith(KEY_GUEST_ID_PREFIX)
        ? [row.byId]
        : [],
    ),
  );
  if (ids.size === 0) return new Map();
  try {
    const users = await runWithSpace(null, () => listUsers());
    return new Map(
      users
        .filter((user) => ids.has(user.id))
        .map((user) => [user.id, user.nickname ?? user.name] as const),
    );
  } catch {
    return new Map();
  }
}

export async function loadRecentFiles(
  query: RecentQuery,
  options: { now?: number; signal?: AbortSignal; adapter?: ListAdapter } = {},
): Promise<RecentFilesResponse> {
  const now = options.now ?? Date.now();
  const audits = await listEntryAudits();
  const rows = buildRecentRows(audits, {
    now,
    days: query.days,
    limit: query.limit,
  });
  const [located, displayNames] = await Promise.all([
    locateByLayoutKey(
      new Set(rows.map((row) => row.layoutKey)),
      options.adapter ?? getAdapter(),
      { signal: options.signal },
    ),
    memberDisplayNames(rows),
  ]);
  const items: RecentFileItem[] = [];
  for (const row of rows) {
    const item = recentItem(
      row,
      audits[row.layoutKey],
      located.found.get(row.layoutKey),
      located.complete,
      displayNames,
    );
    if (item) items.push(item);
  }
  return {
    now: new Date(now).toISOString(),
    days: query.days,
    items,
    truncated: !located.complete,
  };
}
