// 서버와 관리자 화면이 함께 쓰는 표시 규칙. 저장소·Node 의존성을 두지 않는다.
export const CLI_SESSION_LABEL_PREFIX = "CLI · ";
export const MAX_CLI_SESSIONS = 5;

export function isCliSession(session: { deviceLabel: string }): boolean {
  return session.deviceLabel.startsWith(CLI_SESSION_LABEL_PREFIX);
}
