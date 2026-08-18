import packageJson from "../../package.json";
import { checkStarred } from "@/lib/github-star";

export const UPDATE_SOURCE_REPOSITORY = "Youkamii/sharedesk-template";
export const UPDATE_WORKFLOW_PATH = ".github/workflows/sharedesk-update.yml";
// GitHub Actions API는 workflow를 파일 이름으로 지정한다.
const UPDATE_WORKFLOW_FILE = UPDATE_WORKFLOW_PATH.split("/").at(-1)!;

type Environment = Record<string, string | undefined>;

export interface UpdateRun {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  repository: string | null;
  workflowUrl: string | null;
  configured: boolean;
  canDispatch: boolean;
  run: UpdateRun | null;
  // 원본 저장소에 별을 눌렀는지. 토큰이 없어 확인할 수 없으면 null.
  starred: boolean | null;
  error?: string;
}

interface GitHubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

interface ParsedSemver {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
}

const OWNER_PATTERN = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftIsNumber = /^\d+$/.test(leftPart);
    const rightIsNumber = /^\d+$/.test(rightPart);
    if (leftIsNumber && rightIsNumber) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error(`Invalid semantic version: ${!parsedLeft ? left : right}`);
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] < parsedRight[key]) return -1;
    if (parsedLeft[key] > parsedRight[key]) return 1;
  }
  return compareIdentifiers(parsedLeft.prerelease, parsedRight.prerelease);
}

function isValidRepository(owner: string, repository: string): boolean {
  return (
    OWNER_PATTERN.test(owner) &&
    REPOSITORY_PATTERN.test(repository) &&
    repository !== "." &&
    repository !== ".."
  );
}

function invalidRepository(message: string) {
  return { repository: null, configured: false, error: message } as const;
}

export function resolveUpdateRepository(env: Environment = process.env):
  | { repository: string; configured: true; error?: undefined }
  | { repository: null; configured: false; error: string } {
  const explicit = env.SHAREDESK_GITHUB_REPOSITORY;
  if (explicit && explicit.trim()) {
    if (explicit !== explicit.trim()) {
      return invalidRepository(
        "SHAREDESK_GITHUB_REPOSITORY 값이 올바르지 않습니다.",
      );
    }
    const parts = explicit.split("/");
    if (parts.length !== 2 || !isValidRepository(parts[0], parts[1])) {
      return invalidRepository(
        "SHAREDESK_GITHUB_REPOSITORY를 owner/repository 형식으로 설정해 주세요.",
      );
    }
    return { repository: explicit, configured: true };
  }

  const owner = env.VERCEL_GIT_REPO_OWNER;
  const repository = env.VERCEL_GIT_REPO_SLUG;
  if (!owner && !repository) {
    return invalidRepository(
      "설치 저장소 정보가 설정되지 않았습니다.",
    );
  }
  if (
    !owner ||
    !repository ||
    owner !== owner.trim() ||
    repository !== repository.trim() ||
    !isValidRepository(owner, repository)
  ) {
    return invalidRepository(
      "Vercel 설치 저장소 정보가 올바르지 않습니다.",
    );
  }
  return { repository: `${owner}/${repository}`, configured: true };
}

export function getUpdateWorkflowUrl(repository: string): string {
  return `https://github.com/${repository}/actions/workflows/${UPDATE_WORKFLOW_FILE}`;
}

export function resolveUpdateToken(env: Environment = process.env):
  | { token: string; configured: true; error?: undefined; reason?: undefined }
  | { token: null; configured: false; error: string; reason: "missing" | "invalid" } {
  const value = env.SHAREDESK_GITHUB_TOKEN;
  if (!value || !value.trim()) {
    return {
      token: null,
      configured: false,
      reason: "missing",
      error: "SHAREDESK_GITHUB_TOKEN이 설정되지 않았습니다.",
    };
  }
  if (value !== value.trim()) {
    return {
      token: null,
      configured: false,
      reason: "invalid",
      error: "SHAREDESK_GITHUB_TOKEN 값이 올바르지 않습니다.",
    };
  }
  return { token: value, configured: true };
}

function workflowApiError(status: number): string {
  if (status === 401) {
    return "GitHub 토큰이 유효하지 않습니다. SHAREDESK_GITHUB_TOKEN을 확인해 주세요.";
  }
  if (status === 403) {
    return "GitHub 토큰에 워크플로 실행 권한이 없습니다.";
  }
  if (status === 404) {
    return "워크플로를 찾을 수 없습니다. 저장소 설정 또는 토큰의 저장소 접근 권한을 확인해 주세요.";
  }
  return `GitHub 응답 ${status}`;
}

// 자동 업데이트 워크플로가 이 설치 저장소에 있는지 확인한다.
// 예전 설치에는 파일이 없는데 토글만 켜지면 "자정 자동 업데이트"가
// 조용히 아무 일도 안 하게 되므로, 켜기 전에 이 검사로 막는다.
// 확인할 수 없는 환경(토큰·저장소 미설정, API 장애)은 null — 켜기를
// 막지 않는다.
export async function hasAutoUpdateWorkflow(options?: {
  env?: Environment;
  fetchImpl?: typeof fetch;
}): Promise<boolean | null> {
  const resolved = resolveUpdateRepository(options?.env);
  const token = resolveUpdateToken(options?.env);
  if (!resolved.configured || !token.configured) return null;
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${resolved.repository}/actions/workflows?per_page=100`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token.token}`,
        },
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      workflows?: Array<{ path?: string }>;
    };
    if (!Array.isArray(body.workflows)) return null;
    return body.workflows.some(
      (workflow) =>
        workflow.path === ".github/workflows/sharedesk-auto-update.yml",
    );
  } catch {
    return null;
  }
}

// 자동 업데이트 켜기/끄기를 저장소의 예약 워크플로에 등록한다.
// 워크플로가 sharedesk-auto-update.json에 기록해 두면 자정 실행이 그
// 기록만 읽는다 — 앱 주소를 몰라도 되는 유일한 통신로다.
export async function dispatchAutoUpdateRegister(
  action: "enable" | "disable",
  timezone?: string | null,
  options?: { env?: Environment; fetchImpl?: typeof fetch },
): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string }
> {
  const resolved = resolveUpdateRepository(options?.env);
  if (!resolved.configured) {
    return { ok: false, status: 409, error: resolved.error };
  }
  const token = resolveUpdateToken(options?.env);
  if (!token.configured) {
    return { ok: false, status: 409, error: token.error };
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${resolved.repository}/actions/workflows/sharedesk-auto-update.yml/dispatches`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            action,
            ...(action === "enable" && timezone ? { timezone } : {}),
          },
        }),
      },
    );
  } catch {
    return { ok: false, status: 502, error: "GitHub에 연결하지 못했습니다." };
  }
  if (response.status !== 204) {
    return { ok: false, status: 502, error: workflowApiError(response.status) };
  }
  return { ok: true };
}

export async function dispatchUpdateWorkflow(options?: {
  env?: Environment;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; repository: string; workflowUrl: string }
  | { ok: false; status: number; error: string }
> {
  const resolved = resolveUpdateRepository(options?.env);
  if (!resolved.configured) {
    return { ok: false, status: 409, error: resolved.error };
  }
  const token = resolveUpdateToken(options?.env);
  if (!token.configured) {
    return { ok: false, status: 409, error: token.error };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${resolved.repository}/actions/workflows/${UPDATE_WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
  } catch {
    return { ok: false, status: 502, error: "GitHub에 연결하지 못했습니다." };
  }
  if (response.status !== 204) {
    return { ok: false, status: 502, error: workflowApiError(response.status) };
  }
  return {
    ok: true,
    repository: resolved.repository,
    workflowUrl: getUpdateWorkflowUrl(resolved.repository),
  };
}

interface GitHubWorkflowRun {
  id?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  created_at?: unknown;
}

function parseUpdateRun(value: unknown): UpdateRun | null {
  if (typeof value !== "object" || value === null) return null;
  const run = value as GitHubWorkflowRun;
  if (
    typeof run.id !== "number" ||
    typeof run.status !== "string" ||
    typeof run.html_url !== "string" ||
    // 관리자 화면이 이 주소를 링크로 그대로 열므로 GitHub 주소만 신뢰한다.
    !run.html_url.startsWith("https://github.com/") ||
    typeof run.created_at !== "string" ||
    !(run.conclusion == null || typeof run.conclusion === "string")
  ) {
    return null;
  }
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion ?? null,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
  };
}

export async function fetchLatestUpdateRun(options?: {
  env?: Environment;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; run: UpdateRun | null }
  | { ok: false; status: number; error: string }
> {
  const resolved = resolveUpdateRepository(options?.env);
  if (!resolved.configured) {
    return { ok: false, status: 409, error: resolved.error };
  }
  const token = resolveUpdateToken(options?.env);
  if (!token.configured) {
    return { ok: false, status: 409, error: token.error };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${resolved.repository}/actions/workflows/${UPDATE_WORKFLOW_FILE}/runs?event=workflow_dispatch&branch=main&per_page=1`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token.token}`,
        },
      },
    );
  } catch {
    return { ok: false, status: 502, error: "GitHub에 연결하지 못했습니다." };
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: workflowApiError(response.status) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: 502,
      error: "GitHub 워크플로 응답 형식이 올바르지 않습니다.",
    };
  }
  const runs = (payload as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) {
    return {
      ok: false,
      status: 502,
      error: "GitHub 워크플로 응답 형식이 올바르지 않습니다.",
    };
  }
  if (runs.length === 0) {
    return { ok: true, run: null };
  }
  const run = parseUpdateRun(runs[0]);
  if (!run) {
    return {
      ok: false,
      status: 502,
      error: "GitHub 워크플로 응답 형식이 올바르지 않습니다.",
    };
  }
  return { ok: true, run };
}

export function selectLatestStableVersion(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null;

  let latest: string | null = null;
  for (const candidate of releases as GitHubRelease[]) {
    if (
      candidate.draft === true ||
      candidate.prerelease === true ||
      typeof candidate.tag_name !== "string"
    ) {
      continue;
    }
    const parsed = parseSemver(candidate.tag_name);
    if (!parsed || parsed.prerelease.length > 0) continue;
    if (latest === null || compareSemver(candidate.tag_name, latest) > 0) {
      latest = candidate.tag_name.replace(/^v/, "");
    }
  }
  return latest;
}

function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const link of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>/.exec(link);
    if (match && /;\s*rel="next"(?:\s*;|\s*$)/.test(link)) return match[1];
  }
  return null;
}

export async function fetchGitHubReleasePages(
  initialUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
  const releases: unknown[] = [];
  const visited = new Set<string>();
  let url: string | null = initialUrl;
  while (url) {
    if (visited.has(url)) {
      throw new Error("GitHub release pagination loop detected.");
    }
    visited.add(url);
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub 응답 ${response.status}`);
    }
    const page: unknown = await response.json();
    if (!Array.isArray(page)) {
      throw new Error("GitHub 릴리스 응답 형식이 올바르지 않습니다.");
    }
    releases.push(...page);
    const next = nextPageUrl(response.headers.get("link"));
    // 다음 페이지는 응답이 지정한 주소를 따라가므로 GitHub API 밖으로는 나가지 않는다.
    if (next && !next.startsWith("https://api.github.com/")) {
      throw new Error("GitHub 릴리스 응답 형식이 올바르지 않습니다.");
    }
    url = next;
  }
  return releases;
}

// GitHub 릴리스 목록 API는 인덱스 지연·장애로 방금 만든 릴리스는 물론 기존
// 릴리스까지 비어 보일 수 있다. 그때는 전용 latest 엔드포인트로 한 번 더
// 확인해 상태 화면이 "확인 실패"로 끝나지 않게 한다.
export async function fetchLatestStableReleaseFallback(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${UPDATE_SOURCE_REPOSITORY}/releases/latest`,
    {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  // 릴리스가 하나도 없는 저장소는 404를 준다 — 오류가 아니라 "없음"이다.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub 응답 ${response.status}`);
  }
  const payload: unknown = await response.json();
  return selectLatestStableVersion([payload]);
}

export async function getUpdateStatus(options?: {
  env?: Environment;
  fetchImpl?: typeof fetch;
  currentVersion?: string;
}): Promise<UpdateStatus> {
  const currentVersion = options?.currentVersion ?? packageJson.version;
  const resolved = resolveUpdateRepository(options?.env);
  const workflowUrl = resolved.repository
    ? getUpdateWorkflowUrl(resolved.repository)
    : null;
  const token = resolveUpdateToken(options?.env);
  const canDispatch = resolved.configured && token.configured;
  const errors: string[] = [];
  if (resolved.error) errors.push(resolved.error);
  // 토큰이 없는 것은 선택 기능 미사용이지만, 넣었는데 형식이 틀린 것은
  // 관리자가 고쳐야 알 수 있는 문제이므로 상태 창에 드러낸다.
  if (!token.configured && token.reason === "invalid") {
    errors.push(token.error);
  }

  let latestVersion: string | null = null;
  try {
    const fetchImpl = options?.fetchImpl ?? fetch;
    try {
      const releases = await fetchGitHubReleasePages(
        `https://api.github.com/repos/${UPDATE_SOURCE_REPOSITORY}/releases?per_page=100`,
        fetchImpl,
      );
      latestVersion = selectLatestStableVersion(releases);
    } catch (listError) {
      // 목록 조회가 막혀도 latest 단건이 살아 있으면 이어 가고,
      // 폴백까지 실패하면 진단에 유리한 원래 목록 오류를 보고한다.
      latestVersion = await fetchLatestStableReleaseFallback(fetchImpl).catch(
        () => null,
      );
      if (!latestVersion) throw listError;
    }
    if (!latestVersion) {
      latestVersion = await fetchLatestStableReleaseFallback(fetchImpl);
    }
    if (!latestVersion) {
      throw new Error(
        "안정 릴리스를 찾을 수 없습니다.",
      );
    }
  } catch (error) {
    errors.push(
      `최신 버전을 확인하지 못했습니다: ${
        error instanceof Error
          ? error.message
          : "알 수 없는 오류"
      }`,
    );
  }

  let updateAvailable = false;
  if (latestVersion) {
    try {
      updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "버전 형식이 올바르지 않습니다.",
      );
    }
  }

  let starred: boolean | null = null;
  if (token.configured) {
    const check = await checkStarred({
      token: token.token,
      fetchImpl: options?.fetchImpl,
    });
    if (check.ok) starred = check.starred;
  }

  let run: UpdateRun | null = null;
  if (canDispatch) {
    const latestRun = await fetchLatestUpdateRun({
      env: options?.env,
      fetchImpl: options?.fetchImpl,
    });
    if (latestRun.ok) {
      run = latestRun.run;
    } else {
      errors.push(latestRun.error);
    }
  }

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    repository: resolved.repository,
    workflowUrl,
    configured: resolved.configured,
    canDispatch,
    starred,
    run,
    ...(errors.length > 0 ? { error: errors.join(" ") } : {}),
  };
}
