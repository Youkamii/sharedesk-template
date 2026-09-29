// 화면 공용 오류 헬퍼 — 데스크 화면(FilesView)과 위젯 화면이 같은 규칙으로 메시지를 뽑는다.

export function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : fallback;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
