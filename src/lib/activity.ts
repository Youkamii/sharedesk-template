import { after } from "next/server";
import { getAdapter } from "@/lib/storage";
import type { SessionInfo } from "@/lib/auth";

// 데스크 활동 기록 — "누가 언제 무엇을 했는지"를 저장소의 상태 파일에
// 최근 것부터 보관한다. 기록은 최선 노력이다: 어떤 실패도 본 작업
// (업로드·삭제 등)을 막지 않고, 동시 기록이 엇갈리면 몇 번 재시도한
// 뒤 조용히 포기한다.
const FILE = "activity.json";
const MAX_ENTRIES = 200;
const MAX_ATTEMPTS = 3;

export const ACTIVITY_ACTIONS = [
  "upload",
  "trash",
  "restore",
  "purge",
  "empty-trash",
  "rename",
  "move",
  "mkdir",
  "edit",
  "nickname",
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface ActivityEntry {
  at: string;
  actorName: string;
  action: ActivityAction;
  // 대상 이름. empty-trash만 예외로 지운 개수를 담는다(대상이 여럿이라).
  name: string;
  // 공개 폴더로 들어온 무로그인 방문자(#17 B-4). actorName은 방문자가 적은
  // 이름이거나 빈 문자열 — 화면은 "손님 · 이름"/"손님"으로 보여 준다.
  guest?: boolean;
  // 손님 업로드 묶음(#17 B-4): 같은 묶음(group — 공개 폴더)으로 이어 올라온
  // 손님 업로드를 한 줄로 합친다. count는 합친 업로드 수(2 이상일 때만),
  // name은 마지막에 올린 파일이다.
  group?: string;
  count?: number;
}

// 기록하는 쪽 — 세션 이름, 또는 무로그인 방문자면 guest 표시를 함께.
export type ActivityActor = Pick<SessionInfo, "name"> & { guest?: boolean };

// 손님 업로드를 합치는 창 — 앞 줄(같은 묶음의 손님 업로드)의 마지막 시각에서
// 이만큼 안에 올라오면 그 줄에 더한다. 무로그인 업로드가 몰려도 활동 기록
// 200줄을 혼자 다 밀어내지 못하게 한다(파일별 기록은 entry-audit에 그대로 남는다).
export const GUEST_UPLOAD_MERGE_MS = 60_000;
const MAX_GROUP_LENGTH = 128;

/**
 * 새 기록을 맨 앞에 더한 목록(순수). 손님 업로드이고 group이 있으면, 바로
 * 앞 줄이 같은 group의 손님 업로드이고 GUEST_UPLOAD_MERGE_MS 안이면 그 줄을
 * 새 시각·마지막 파일 이름으로 바꾸고 count를 하나 올린다(사이에 다른 활동이
 * 끼었으면 새 줄). 이름이 서로 다르면 누구 것인지 섞이지 않게 이름을 비워
 * "손님"으로만 남긴다.
 */
export function appendActivity(
  entries: ActivityEntry[],
  entry: ActivityEntry,
): ActivityEntry[] {
  const previous = entries[0];
  const gap = previous ? Date.parse(entry.at) - Date.parse(previous.at) : NaN;
  if (
    previous &&
    entry.guest === true &&
    entry.action === "upload" &&
    entry.group !== undefined &&
    previous.guest === true &&
    previous.action === "upload" &&
    previous.group === entry.group &&
    gap >= 0 &&
    gap <= GUEST_UPLOAD_MERGE_MS
  ) {
    const merged: ActivityEntry = {
      ...entry,
      actorName: previous.actorName === entry.actorName ? entry.actorName : "",
      count: Math.min((previous.count ?? 1) + 1, Number.MAX_SAFE_INTEGER),
    };
    return [merged, ...entries.slice(1)].slice(0, MAX_ENTRIES);
  }
  return [entry, ...entries].slice(0, MAX_ENTRIES);
}

interface ActivityFile {
  version: 1;
  entries: ActivityEntry[];
}

function normalize(value: unknown): ActivityFile {
  const raw = value as { entries?: unknown } | null;
  const entries = Array.isArray(raw?.entries)
    ? raw.entries
        .filter((entry): entry is ActivityEntry => {
          const candidate = entry as ActivityEntry | null;
          return (
            !!candidate &&
            typeof candidate.at === "string" &&
            typeof candidate.actorName === "string" &&
            typeof candidate.name === "string" &&
            (ACTIVITY_ACTIONS as readonly string[]).includes(candidate.action)
          );
        })
        .slice(0, MAX_ENTRIES)
        // 선택 필드는 꼴이 맞을 때만 남긴다(손으로 고친 값이 표시를 흔들지 않게).
        .map((entry) => {
          const { guest, group, count, ...rest } = entry;
          return {
            ...rest,
            ...(guest === true ? { guest: true } : {}),
            ...(typeof group === "string" &&
            group.length > 0 &&
            group.length <= MAX_GROUP_LENGTH
              ? { group }
              : {}),
            ...(Number.isSafeInteger(count) && (count as number) >= 2
              ? { count }
              : {}),
          };
        })
    : [];
  return { version: 1, entries };
}

export async function recordActivity(
  session: ActivityActor,
  action: ActivityAction,
  name: string,
  options: { group?: string } = {},
): Promise<void> {
  const entry: ActivityEntry = {
    at: new Date().toISOString(),
    actorName: session.name,
    action,
    name,
    ...(session.guest === true ? { guest: true } : {}),
    ...(options.group ? { group: options.group.slice(0, MAX_GROUP_LENGTH) } : {}),
  };
  try {
    const adapter = getAdapter();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const state = await adapter.readStateVersioned<ActivityFile>(FILE);
      const file = normalize(state.value);
      file.entries = appendActivity(file.entries, entry);
      try {
        await adapter.compareAndSwapState(FILE, file, state.version);
        return;
      } catch {
        // 다른 요청이 먼저 기록했다 — 새 버전 위에서 다시 시도한다.
      }
    }
  } catch (error) {
    console.error("[activity]", error);
  }
}

// 라우트가 쓰는 진입점 — 응답을 먼저 보내고 기록한다. Next 요청 컨텍스트
// 밖(핸들러를 직접 부르는 테스트 등)에서는 after()가 던지므로, 그때는
// 기다리지 않는 호출로 대신하고 본 작업은 계속 성공시킨다.
export function recordActivityAfter(
  session: ActivityActor,
  action: ActivityAction,
  name: string,
  options: { group?: string } = {},
): void {
  try {
    after(() => recordActivity(session, action, name, options));
  } catch {
    void recordActivity(session, action, name, options);
  }
}

export async function listActivity(): Promise<ActivityEntry[]> {
  const state = await getAdapter().readStateVersioned<ActivityFile>(FILE);
  return normalize(state.value).entries;
}
