// 스페이스 슬러그의 순수 규칙. edge에서 도는 proxy도 이 판정을 쓰므로
// 저장소·Node 전용 import를 여기 두면 안 된다.

export const MAX_SPACE_NAME_LENGTH = 40;

// URL 첫 세그먼트가 슬러그다. 기존 최상위 경로·공개 자산과 절대 겹치면 안 된다 —
// 겹치면 그 스페이스가 앱 화면을 가린다. 새 최상위 라우트를 만들면 여기에도
// 추가해야 한다 (tests/spaces.test.ts가 src/app 실물과 대조해 지킨다).
export const RESERVED_SLUGS = new Set([
  // src/app 최상위 라우트
  "admin",
  "api",
  "files",
  "join",
  "pending",
  // public/ 자산과 프레임워크 경로
  "art",
  "fonts",
  "favicon.ico",
  "_next",
  // 스페이스 기능 자신과 헷갈릴 이름들
  "space",
  "spaces",
  ".spaces",
  "desk",
  "login",
  "logout",
  "public",
  "static",
  "assets",
]);

// 소문자 영숫자와 하이픈, 1~32자, 하이픈으로 시작·끝 불가.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * URL 세그먼트를 스페이스 슬러그로 판정한다. 대문자는 소문자로 접는다 —
 * 사용자는 /A/files 처럼 대문자로 적지만 같은 스페이스여야 한다.
 * 형태가 어긋나거나 예약어면 null.
 */
export function parseSpaceSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return null;
  if (RESERVED_SLUGS.has(slug)) return null;
  return slug;
}

/** 스페이스 표시 이름. 비거나 지나치게 길면 null. */
export function parseSpaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_SPACE_NAME_LENGTH) return null;
  // 제어문자는 화면·로그를 깨뜨린다.
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return name;
}

// proxy가 rewrite할 때 서버로 스페이스를 실어 보내는 헤더. 클라이언트가 직접
// 보낸 값은 proxy가 항상 지운다 — 위조된 스페이스 지정을 막는다.
export const SPACE_HEADER = "x-sharedesk-space";
