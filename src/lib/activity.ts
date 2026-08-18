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
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface ActivityEntry {
  at: string;
  actorName: string;
  action: ActivityAction;
  // 대상 이름. empty-trash만 예외로 지운 개수를 담는다(대상이 여럿이라).
  name: string;
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
    : [];
  return { version: 1, entries };
}

export async function recordActivity(
  session: Pick<SessionInfo, "name">,
  action: ActivityAction,
  name: string,
): Promise<void> {
  const entry: ActivityEntry = {
    at: new Date().toISOString(),
    actorName: session.name,
    action,
    name,
  };
  try {
    const adapter = getAdapter();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const state = await adapter.readStateVersioned<ActivityFile>(FILE);
      const file = normalize(state.value);
      file.entries = [entry, ...file.entries].slice(0, MAX_ENTRIES);
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
  session: Pick<SessionInfo, "name">,
  action: ActivityAction,
  name: string,
): void {
  try {
    after(() => recordActivity(session, action, name));
  } catch {
    void recordActivity(session, action, name);
  }
}

export async function listActivity(): Promise<ActivityEntry[]> {
  const state = await getAdapter().readStateVersioned<ActivityFile>(FILE);
  return normalize(state.value).entries;
}
