// 프로세스 메모리 고정 창 카운터 — 무세션 공개 입구의 관례(auth·invitations·
// 공개 폴더 업로드): 키별 상한 + 전역 상한. 키(IP·링크 id)는 위조하거나 늘릴
// 수 있으므로 전역 총량을 함께 본다. 인스턴스마다 따로 세는 최선 노력 장치다
// (서버리스에서 인스턴스가 여럿이면 그만큼 느슨해진다).
//
// 돌려주는 함수는 "이번 시도가 상한을 넘었나"다. 넘은 시도도 전역 창에는
// 센다(업로드 라우트의 원래 동작 그대로).

export interface WindowLimiterOptions {
  windowMs: number;
  // 키 하나가 창 하나에서 허용되는 시도 수.
  perKey: number;
  // 모든 키를 합쳐 창 하나에서 허용되는 시도 수.
  total: number;
  // 키 표가 이 크기를 넘으면 지난 창의 키를 비운다.
  maxKeys?: number;
}

export function createWindowLimiter(
  options: WindowLimiterOptions,
): (key: string, now?: number) => boolean {
  const maxKeys = options.maxKeys ?? 1000;
  const attempts = new Map<string, { count: number; resetAt: number }>();
  let totalWindow = { count: 0, resetAt: 0 };

  return (key: string, now: number = Date.now()): boolean => {
    if (now > totalWindow.resetAt) {
      totalWindow = { count: 0, resetAt: now + options.windowMs };
    }
    totalWindow.count++;
    if (totalWindow.count > options.total) return true;

    const entry = attempts.get(key);
    if (!entry || now > entry.resetAt) {
      attempts.set(key, { count: 1, resetAt: now + options.windowMs });
      if (attempts.size > maxKeys) {
        for (const [candidate, value] of attempts) {
          if (now > value.resetAt) attempts.delete(candidate);
        }
      }
      return 1 > options.perKey;
    }
    entry.count++;
    return entry.count > options.perKey;
  };
}
