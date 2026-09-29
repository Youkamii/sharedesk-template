// 데스크 API 호출 공용 규칙 — 401이면 로그인 화면으로, 403이면 화면을 새로 그려 역할 변화를
// 반영하고, 실패 본문의 error 문구는 번역해서 던진다. 데스크 화면과 위젯이 같은 것을 쓴다.

export type ApiJson = <T>(pathname: string, init?: RequestInit) => Promise<T>;

export interface ApiJsonOptions {
  translate: (text: string) => string;
  onUnauthorized: () => void;
  onForbidden?: () => void;
}

export function createApiJson({
  translate,
  onUnauthorized,
  onForbidden,
}: ApiJsonOptions): ApiJson {
  return async function apiJson<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(pathname, init);
    if (response.status === 401) {
      onUnauthorized();
      const error = new Error(translate("세션이 만료되었습니다"));
      Object.assign(error, { status: response.status });
      throw error;
    }
    if (response.status === 403) onForbidden?.();
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        typeof body?.error === "string"
          ? translate(body.error)
          : translate("요청에 실패했습니다"),
      );
      // 본문도 함께 넘긴다 — 호출부가 starRequired 같은 부가 정보를 봐야 한다.
      Object.assign(error, { status: response.status, body });
      throw error;
    }
    return body as T;
  };
}
