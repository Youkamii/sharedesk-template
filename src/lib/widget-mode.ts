// 위젯 모드 판정 — 데스크톱 위젯 껍데기(widget/)가 데스크 원점에 심는 쿠키를 본다.
// 주소는 웹과 같고 환경이 화면을 정한다: 쿠키가 있으면 위젯 화면, 없으면 웹 화면.
// 껍데기는 실행할 때마다 쿠키를 다시 심으므로 값(껍데기 버전)이 곧 살아 있음의 표시다.

export const WIDGET_COOKIE = "sharedesk_widget";

// 껍데기 버전은 "0.1.0" 꼴이다. 손으로 심은 이상한 값은 위젯으로 치지 않는다.
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,32})?$/;

export interface WidgetContext {
  version: string;
}

export function parseWidgetCookie(
  value: string | undefined | null,
): WidgetContext | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return VERSION_PATTERN.test(trimmed) ? { version: trimmed } : null;
}

export function isWidgetRequest(value: string | undefined | null): boolean {
  return parseWidgetCookie(value) !== null;
}

// next/headers의 cookies()처럼 get(name)을 가진 저장소에서 바로 판정한다.
export function isWidgetCookieStore(store: {
  get(name: string): { value: string } | undefined;
}): boolean {
  return isWidgetRequest(store.get(WIDGET_COOKIE)?.value);
}
