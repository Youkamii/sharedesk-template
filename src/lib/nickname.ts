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
