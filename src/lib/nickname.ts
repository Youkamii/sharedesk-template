import { INVISIBLE_CHARS } from "@/lib/storage/types";

// 닉네임 규칙 — 순수 검증 모듈. API 입력과 저장 파일 정규화가 같은 판정을
// 쓰도록 한 곳에서 정한다 (users.ts의 parseOptionalByteLimit과 같은 위치 원칙).
//
// 허용 문자: 한글 음절(가-힣)·영문 대소문자·숫자와 - . ( ) @ ~ # ^ &.
// 공백·슬래시·제어문자·자모(ㄱ, ㅏ)·이모지는 받지 않는다.

export const MIN_NICKNAME_LENGTH = 1;
export const MAX_NICKNAME_LENGTH = 20;

// 문자 클래스는 인쇄 가능한 문자만 담는다 — 리터럴 제어문자를 넣지 않는다.
// 허용 목록 방식이라 제어문자·공백류는 목록에 없다는 것만으로 거부된다.
const NICKNAME_SHAPE = /^[가-힣A-Za-z0-9.()@~#^&-]+$/;

// trim 후 규칙을 통과한 문자열을 돌려준다. 문자열이 아니거나 규칙에
// 어긋나면 null — 400 응답이나 기본값 처리는 호출자가 판단한다.
export function parseNickname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const nickname = value.trim();
  if (
    nickname.length < MIN_NICKNAME_LENGTH ||
    nickname.length > MAX_NICKNAME_LENGTH
  ) {
    return null;
  }
  return NICKNAME_SHAPE.test(nickname) ? nickname : null;
}

// 공개 폴더 방문자가 업로드할 때 스스로 적는 "보내는 사람" 이름(#17 B-4).
// 무로그인이라 신원 확인이 아니라 표시용이다 — 화면은 언제나 "손님 · 이름"
// 꼴로 보여 멤버 이름과 섞이지 않게 한다(guestDisplayName).
//
// 닉네임 규칙(20자·허용 문자 목록)은 쓰지 않는다: 띄어쓰기와 괄호가 들어간
// "홍길동 (디자인팀)" 같은 이름을 받아야 해서다. 대신 보이지 않는 문자를
// 걷어 낸다 — 저장소 이름 검증과 같은 조각(INVISIBLE_CHARS: 제어문자·bidi·
// zero-width·BOM)에, 이름에서 빈칸처럼 보이거나 아무것도 안 보이는 문자를 더한다:
// C1 제어, 소프트 하이픈(U+00AD), 결합 문자 자리채움(U+034F), 아랍 글자 표지
// (U+061C), 몽골 모음 구분자(U+180E), word joiner 계열(U+2060–2065), 한글 채움
// 문자(U+115F·1160·3164·FFA0), 이형 선택자(U+FE00–FE0F), 행간 주석(U+FFF9–FFFB),
// 태그 문자(U+E0000–E007F).
export const MAX_GUEST_NAME_LENGTH = 40;

const GUEST_NAME_INVISIBLE = new RegExp(
  String.raw`[${INVISIBLE_CHARS}\u0080-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u2060-\u2065\u3164\ufe00-\ufe0f\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]`,
  "gu",
);

// 반환: 정제된 이름 / null(이름 없음 — 비었거나 보내지 않음, 정제하고 나니
// 결합 문자·공백만 남음) / undefined(받을 수 없는 값 — 문자열이 아니거나 정제 후
// MAX_GUEST_NAME_LENGTH자 초과). 순서: 보이지 않는 문자 제거 → 공백 접기.
// 줄바꿈·탭도 제어문자라 먼저 지워진다(띄어 쓰려면 공백을 쓴다).
export function parseGuestName(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(GUEST_NAME_INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^[\p{M}\s]+$/u.test(cleaned)) return null;
  return cleaned.length > MAX_GUEST_NAME_LENGTH ? undefined : cleaned;
}

// 업로드 요청 헤더로 온 이름. 헤더에는 ASCII만 실을 수 있어 화면이
// percent-encoding으로 보낸다 — URL 쿼리로 보내면 접근 로그에 실명이 남아서다.
// 풀 수 없는 값·지나치게 긴 값은 undefined(받지 않음).
export const GUEST_NAME_HEADER = "x-sharedesk-sender";

export function parseGuestNameHeader(
  raw: string | null,
): string | null | undefined {
  if (raw === null || raw === "") return null;
  // 40자 × UTF-8 4바이트 × "%XX" 3글자 = 480. 여유를 두되 끝없이 풀지 않는다.
  if (raw.length > 1024) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return parseGuestName(decoded);
}

// 무로그인 방문자 표시. 이름이 있으면 "손님 · 이름", 없으면 "손님".
// 번역 함수는 호출자 것을 받는다(이 모듈은 i18n을 모르는 순수 모듈이다).
export function guestDisplayName(
  name: string | null | undefined,
  translate: (text: string, vars?: Record<string, string | number>) => string,
): string {
  return name ? translate("손님 · {name}", { name }) : translate("손님");
}
