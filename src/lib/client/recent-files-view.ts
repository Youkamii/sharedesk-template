// 최근 파일 창(#16 C-1)의 화면 쪽 순수 도우미 — "3분 전/어제 14:02", 행위 문구,
// NEW 점 판정(#16 C-2 규칙 그대로), 응답 검사, 서버 시계 보정.

import { LOCALE_BCP47, type Locale } from "@/lib/i18n";
import {
  folderSeenAt,
  isNewEntry,
  type NewBadgeState,
  type OwnUploadIndex,
} from "@/lib/client/new-badges";
import type {
  RecentAction,
  RecentFileItem,
  RecentFilesResponse,
} from "@/lib/recent-files";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type RecentTimeParts =
  | { kind: "now" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "yesterday" }
  | { kind: "date" };

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * 상대 시각의 꼴. 1분 안(앞날짜 포함)은 방금, 1시간 안은 n분 전, 같은 날은
 * n시간 전, 하루 전 날짜는 어제(시각을 붙인다), 그보다 앞은 날짜. 날짜 경계는
 * 브라우저의 지역 시간대로 가른다.
 */
export function recentTimeParts(at: number, now: number): RecentTimeParts {
  const diff = now - at;
  if (diff < MINUTE_MS) return { kind: "now" };
  if (diff < HOUR_MS) {
    return { kind: "minutes", count: Math.floor(diff / MINUTE_MS) };
  }
  const atDate = new Date(at);
  const nowDate = new Date(now);
  if (sameLocalDay(atDate, nowDate)) {
    return { kind: "hours", count: Math.floor(diff / HOUR_MS) };
  }
  const yesterday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate() - 1,
  );
  if (sameLocalDay(atDate, yesterday)) return { kind: "yesterday" };
  return { kind: "date" };
}

type Translate = (text: string, vars?: Record<string, string | number>) => string;

export function formatRecentTime(
  at: number,
  now: number,
  locale: Locale,
  t: Translate,
): string {
  const parts = recentTimeParts(at, now);
  const bcp47 = LOCALE_BCP47[locale];
  switch (parts.kind) {
    case "now":
      return t("방금 전");
    case "minutes":
      return t("{count}분 전", { count: parts.count });
    case "hours":
      return t("{count}시간 전", { count: parts.count });
    case "yesterday":
      return t("어제 {time}", {
        time: new Date(at).toLocaleTimeString(bcp47, {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }),
      });
    default:
      return new Date(at).toLocaleString(bcp47, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
  }
}

// 행위 문구 — 관리자 활동 기록과 같은 원문을 쓴다(번역도 같다).
const ACTION_LABELS: Record<RecentAction, string> = {
  upload: "업로드",
  edit: "내용 수정",
  rename: "이름 변경",
  move: "이동",
};

export function recentActionLabel(action: RecentAction): string {
  return ACTION_LABELS[action];
}

/**
 * 안 본 항목인가 — NEW 배지(#16 C-2)와 같은 판정: 지금 있는 파일이 그 폴더를 마지막으로
 * 본 기준보다 늦게 바뀌었고 내가 올린 그 버전이 아니면 NEW. 자리가 없는 항목·폴더는 점이 없다.
 */
export function recentItemIsNew(
  item: Pick<RecentFileItem, "location">,
  state: NewBadgeState | null,
  own: OwnUploadIndex,
): boolean {
  const location = item.location;
  if (!state || !location) return false;
  return isNewEntry(
    location.entry,
    folderSeenAt(state, location.parentId),
    own,
  );
}

/** 서버 시각 − 받은 순간의 브라우저 시각. 읽을 수 없으면 0(보정 없음). */
export function serverClockOffset(serverNow: unknown, receivedAt: number): number {
  if (typeof serverNow !== "string") return 0;
  const time = Date.parse(serverNow);
  return Number.isFinite(time) ? time - receivedAt : 0;
}

const ACTIONS = new Set<string>(Object.keys(ACTION_LABELS));

function isLocation(value: unknown): value is RecentFileItem["location"] {
  const location = value as RecentFileItem["location"] | undefined;
  return (
    location === null ||
    (!!location &&
      typeof location.entry?.id === "string" &&
      typeof location.parentId === "string" &&
      Array.isArray(location.breadcrumbs) &&
      typeof location.path === "string")
  );
}

function isRecentItem(value: unknown): value is RecentFileItem {
  const item = value as Partial<RecentFileItem> | null;
  return (
    !!item &&
    typeof item.layoutKey === "string" &&
    typeof item.name === "string" &&
    typeof item.isFolder === "boolean" &&
    typeof item.at === "string" &&
    Number.isFinite(Date.parse(item.at)) &&
    typeof item.action === "string" &&
    ACTIONS.has(item.action) &&
    typeof item.count === "number" &&
    !!item.actor &&
    typeof item.actor.guest === "boolean" &&
    (item.exists === true || item.exists === false || item.exists === null) &&
    isLocation(item.location)
  );
}

/** 응답 본문 검사 — 꼴이 어긋난 줄은 버리고, 목록 자체가 없으면 null. */
export function parseRecentResponse(body: unknown): RecentFilesResponse | null {
  const value = body as Partial<RecentFilesResponse> | null;
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) {
    return null;
  }
  return {
    now: typeof value.now === "string" ? value.now : "",
    days: typeof value.days === "number" ? value.days : 0,
    items: value.items.filter(isRecentItem),
    truncated: value.truncated === true,
    explored: typeof value.explored === "number" ? value.explored : 0,
  };
}
