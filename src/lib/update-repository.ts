type Environment = Record<string, string | undefined>;

const OWNER_PATTERN =
  /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

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
    return invalidRepository("설치 저장소 정보가 설정되지 않았습니다.");
  }
  if (
    !owner ||
    !repository ||
    owner !== owner.trim() ||
    repository !== repository.trim() ||
    !isValidRepository(owner, repository)
  ) {
    return invalidRepository("Vercel 설치 저장소 정보가 올바르지 않습니다.");
  }
  return { repository: `${owner}/${repository}`, configured: true };
}

export function getUpdateWorkflowUrl(repository: string): string {
  return `https://github.com/${repository}/actions/workflows/sharedesk-update.yml`;
}
