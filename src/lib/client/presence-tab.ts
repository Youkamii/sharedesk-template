// 접속자 심장박동의 탭 식별값 — 같은 브라우저 세션의 탭마다 하나. 데스크 화면과 위젯이 공유한다.
// sessionStorage가 막힌 환경에서는 이 화면을 연 동안만 메모리에 든 값으로 구분한다.

import type { PresenceMember, PresenceSnapshot } from "@/lib/presence";

export const PRESENCE_TAB_KEY = "sharedesk.presence-tab";

let memoryTabId = "";

export function presenceTabId(): string {
  if (memoryTabId) return memoryTabId;
  let stored = "";
  try {
    stored = window.sessionStorage.getItem(PRESENCE_TAB_KEY) ?? "";
  } catch {
    // 저장소가 막힌 브라우저 — 아래 메모리 값만 쓴다
  }
  memoryTabId = stored || crypto.randomUUID();
  if (!stored) {
    try {
      window.sessionStorage.setItem(PRESENCE_TAB_KEY, memoryTabId);
    } catch {
      // 메모리에 든 식별값만으로도 현재 탭은 분리된다
    }
  }
  return memoryTabId;
}

// 서버 응답을 화면이 믿을 수 있는 모양으로 거른다 — 이름·나 표시·전송 목록이 없는 항목은 버린다.
export function normalizePresenceSnapshot(body: unknown): {
  count: number;
  members: PresenceMember[];
} {
  const snapshot = body as Partial<PresenceSnapshot> | null;
  return {
    count: Number.isSafeInteger(snapshot?.count) ? snapshot!.count! : 0,
    members: Array.isArray(snapshot?.members)
      ? snapshot.members.filter(
          (member: unknown): member is PresenceMember =>
            !!member &&
            typeof member === "object" &&
            typeof (member as PresenceMember).name === "string" &&
            typeof (member as PresenceMember).isSelf === "boolean" &&
            Array.isArray((member as PresenceMember).transfers),
        )
      : [],
  };
}
