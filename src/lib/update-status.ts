import packageJson from "../../package.json";

export const UPDATE_SOURCE_REPOSITORY = "Youkamii/sharedesk-template";
export const UPDATE_WORKFLOW_PATH = ".github/workflows/sharedesk-update.yml";

type Environment = Record<string, string | undefined>;

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  repository: string | null;
  workflowUrl: string | null;
  configured: boolean;
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
  return `https://github.com/${repository}/actions/workflows/sharedesk-update.yml`;
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
    url = nextPageUrl(response.headers.get("link"));
  }
  return releases;
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
  const errors: string[] = [];
  if (resolved.error) errors.push(resolved.error);

  let latestVersion: string | null = null;
  try {
    const fetchImpl = options?.fetchImpl ?? fetch;
    const releases = await fetchGitHubReleasePages(
      `https://api.github.com/repos/${UPDATE_SOURCE_REPOSITORY}/releases?per_page=100`,
      fetchImpl,
    );
    latestVersion = selectLatestStableVersion(releases);
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

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    repository: resolved.repository,
    workflowUrl,
    configured: resolved.configured,
    ...(errors.length > 0 ? { error: errors.join(" ") } : {}),
  };
}
