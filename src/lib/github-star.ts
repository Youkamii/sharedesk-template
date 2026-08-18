// 업데이트를 받아 가는 원본 저장소. 별도 이 저장소에 남긴다.
// update-status가 이 파일을 부르므로 상수를 거기서 가져오면 순환 참조가 된다.
// 값이 어긋나지 않도록 tests/update-flow.test.ts가 두 상수를 대조한다.
export const STAR_REPOSITORY = "Youkamii/sharedesk-template";

export function starPageUrl(): string {
  return `https://github.com/${STAR_REPOSITORY}`;
}

type Environment = Record<string, string | undefined>;

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

export type StarCheck =
  | { ok: true; starred: boolean }
  | { ok: false; status: number; error: string };

export type StarResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

function starApiError(status: number): string {
  if (status === 401) {
    return "GitHub 토큰이 유효하지 않습니다. SHAREDESK_GITHUB_TOKEN을 확인해 주세요.";
  }
  if (status === 403 || status === 404) {
    // fine-grained 토큰은 권한이 없을 때 404를 주기도 한다.
    return "GitHub 토큰에 별(Starring) 권한이 없습니다. 토큰 권한에 Starring을 추가하거나 저장소에서 직접 별을 눌러 주세요.";
  }
  return `GitHub 응답 ${status}`;
}

// 스타 여부 확인: 눌렀으면 204, 아니면 404를 준다.
export async function checkStarred(options?: {
  token?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<StarCheck> {
  const token = options?.token;
  if (!token) {
    return {
      ok: false,
      status: 409,
      error: "SHAREDESK_GITHUB_TOKEN이 설정되지 않았습니다.",
    };
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/user/starred/${STAR_REPOSITORY}`,
      {
        cache: "no-store",
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
      },
    );
  } catch {
    return { ok: false, status: 502, error: "GitHub에 연결하지 못했습니다." };
  }
  if (response.status === 204) return { ok: true, starred: true };
  if (response.status === 404) return { ok: true, starred: false };
  return { ok: false, status: 502, error: starApiError(response.status) };
}

// 관리자가 동의했을 때만 부른다. 토큰 소유자의 계정으로 별이 남는다.
export async function addStar(options?: {
  token?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<StarResult> {
  const token = options?.token;
  if (!token) {
    return {
      ok: false,
      status: 409,
      error: "SHAREDESK_GITHUB_TOKEN이 설정되지 않았습니다.",
    };
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/user/starred/${STAR_REPOSITORY}`,
      {
        method: "PUT",
        cache: "no-store",
        headers: {
          ...GITHUB_HEADERS,
          Authorization: `Bearer ${token}`,
          "Content-Length": "0",
        },
      },
    );
  } catch {
    return { ok: false, status: 502, error: "GitHub에 연결하지 못했습니다." };
  }
  // 이미 눌러 둔 저장소도 204를 준다.
  if (response.status === 204) return { ok: true };
  return { ok: false, status: 502, error: starApiError(response.status) };
}

export function resolveStarToken(env: Environment = process.env): string | null {
  const value = env.SHAREDESK_GITHUB_TOKEN;
  return value && value === value.trim() && value.length > 0 ? value : null;
}
