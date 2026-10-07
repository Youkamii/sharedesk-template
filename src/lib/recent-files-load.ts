import { KEY_GUEST_ID_PREFIX } from "@/lib/auth";
import { listEntryAudits } from "@/lib/entry-audit";
import {
  buildRecentRows,
  goneByRecord,
  RECENT_LOCATE_ROWS,
  RECENT_TRAVERSAL_LIMIT,
  recentItem,
  type RecentActor,
  type RecentFileItem,
  type RecentFilesResponse,
  type RecentQuery,
  type RecentRow,
} from "@/lib/recent-files";
import {
  pathFrom,
  ROOT_CRUMB,
  TraversalBudget,
  walkFolders,
  type ListAdapter,
  type StorageSearchResult,
} from "@/lib/search";
import { runWithSpace } from "@/lib/space-store";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { listUsers } from "@/lib/users";

// 최근 파일(#16 C-1)의 서버 쪽 — 내력 읽기 → 줄 만들기 → 지금 자리 찾기 →
// 화면 이름 붙이기. 모든 저장소 접근은 호출한 요청의 스페이스 문맥 안에서
// 일어난다(러너가 세운다) — 내력 파일도, 위치를 찾는 목록도 그 스페이스 것이다.

// 폴더 목록을 동시에 몇 개까지 읽을지(drive는 폴더 하나가 왕복 한 번이다).
const LIST_CONCURRENCY = 4;

/**
 * layoutKey들의 지금 자리를 루트부터 찾는다 — 검색과 같은 순회(walkFolders:
 * 숨김 항목도 예산을 쓰고, 목록 읽기 실패는 그대로 던진다). 다 찾으면 바로
 * 멈추고, 상한에 걸리면 complete=false — 그때 못 찾은 항목은 "확인 못 함"이다.
 */
export async function locateLayoutKeys(
  wanted: ReadonlySet<string>,
  adapter: ListAdapter = getAdapter(),
  options: { maxTraversal?: number; signal?: AbortSignal } = {},
): Promise<{
  found: Map<string, StorageSearchResult>;
  complete: boolean;
  explored: number;
}> {
  const found = new Map<string, StorageSearchResult>();
  if (wanted.size === 0) return { found, complete: true, explored: 0 };
  const budget = new TraversalBudget(
    options.maxTraversal ?? RECENT_TRAVERSAL_LIMIT,
  );
  const outcome = await walkFolders(
    adapter,
    { id: ROOT_ID, breadcrumbs: [ROOT_CRUMB] },
    undefined,
    budget,
    options.signal,
    (entry, parent) => {
      if (wanted.has(entry.layoutKey) && !found.has(entry.layoutKey)) {
        found.set(entry.layoutKey, {
          entry,
          parentId: parent.id,
          breadcrumbs: parent.breadcrumbs,
          path: pathFrom(parent.breadcrumbs, entry.name),
        });
      }
      return found.size < wanted.size;
    },
    { concurrency: LIST_CONCURRENCY },
  );
  return {
    found,
    complete: outcome !== "truncated",
    explored: budget.explored,
  };
}

/**
 * 행위자 표시 — 공개 폴더 손님은 방문자가 적은 이름, 접속 키 손님은 이름 없는
 * 손님, 멤버는 지금 별명(nicknames: 명단 id → 별명). 별명이 없거나 명단에 없으면
 * 이름을 비운다 — 실명(구글 이름)은 최근 파일로 내보내지 않는다.
 */
export function recentActor(
  row: Pick<RecentRow, "by" | "byId" | "guest">,
  nicknames: ReadonlyMap<string, string>,
): RecentActor {
  if (row.guest) return { name: row.by, guest: true };
  if (row.byId?.startsWith(KEY_GUEST_ID_PREFIX)) {
    return { name: null, guest: true };
  }
  return { name: (row.byId && nicknames.get(row.byId)) || null, guest: false };
}

// 멤버의 지금 별명. 명단의 진실 원천은 기본 데스크라 어느 스페이스 문맥에서
// 불러도 기본 문맥에서 읽는다(users.resolveDisplayName과 같은 규칙). 명단을
// 못 읽으면 별명 없이(= "멤버") 낸다.
async function memberNicknames(
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
      users.flatMap((user) =>
        ids.has(user.id) && user.nickname ? [[user.id, user.nickname] as const] : [],
      ),
    );
  } catch {
    return new Map();
  }
}

/**
 * 최근 days일의 줄을 limit개까지. 휴지통 기록(deleted)이 마지막인 항목은 찾지
 * 않고 "지워짐", 나머지는 앞 RECENT_LOCATE_ROWS줄의 항목만 RECENT_TRAVERSAL_LIMIT
 * 안에서 찾는다. limit은 이름 모르는 옛 기록을 거른 뒤에 적용한다.
 */
export async function loadRecentFiles(
  query: RecentQuery,
  options: { now?: number; signal?: AbortSignal; adapter?: ListAdapter } = {},
): Promise<RecentFilesResponse> {
  const audits = await listEntryAudits();
  const rows = buildRecentRows(audits, {
    now: options.now ?? Date.now(),
    days: query.days,
  });
  const wanted = new Set(
    rows
      .slice(0, RECENT_LOCATE_ROWS)
      .map((row) => row.layoutKey)
      .filter((layoutKey) => !goneByRecord(audits[layoutKey])),
  );
  const [located, nicknames] = await Promise.all([
    locateLayoutKeys(wanted, options.adapter ?? getAdapter(), {
      signal: options.signal,
    }),
    memberNicknames(rows),
  ]);
  const items: RecentFileItem[] = [];
  for (const row of rows) {
    const audit = audits[row.layoutKey];
    const location = located.found.get(row.layoutKey) ?? null;
    const exists = location
      ? true
      : goneByRecord(audit) ||
          (wanted.has(row.layoutKey) && located.complete)
        ? false
        : null;
    const item = recentItem(
      row,
      audit,
      location,
      exists,
      recentActor(row, nicknames),
    );
    if (!item) continue;
    items.push(item);
    if (items.length >= query.limit) break;
  }
  return {
    now: new Date().toISOString(),
    days: query.days,
    items,
    truncated: items.some((item) => item.exists === null),
    explored: located.explored,
  };
}
