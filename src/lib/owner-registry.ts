import "server-only";

import packageMetadata from "../../package.json";
import { resolvePublicOrigin } from "@/lib/public-origin";
import { resolveUpdateRepository } from "@/lib/update-repository";

type Environment = Readonly<Record<string, string | undefined>>;

type RegistryConfig =
  | {
      configured: true;
      endpoint: string;
      installationId: string;
      sharedSecret: string;
      error: null;
    }
  | {
      configured: false;
      error: string;
    };

export interface OwnerRegistryStatus {
  enabled: boolean;
  version: string;
  site: string | null;
  repository: string | null;
  error: string | null;
}

export type OwnerRegistryObservation =
  | {
      ok: true;
      status: OwnerRegistryStatus;
      observedAt: string;
      created: boolean;
    }
  | {
      ok: false;
      status: OwnerRegistryStatus;
      error: string;
      reason: "disabled" | "upstream";
    };

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function resolveConfig(env: Environment): RegistryConfig {
  const endpointValue = env.SHAREDESK_OWNER_REGISTRY_ENDPOINT?.trim() ?? "";
  const sharedSecret = env.SHAREDESK_OWNER_REGISTRY_SECRET ?? "";
  const installationId = env.SHAREDESK_INSTALLATION_ID?.trim() ?? "";

  if (!endpointValue && !sharedSecret && !installationId) {
    return {
      configured: false,
      error: "비공개 설치 등록부가 설정되지 않았습니다.",
    };
  }
  if (!endpointValue || !sharedSecret || !installationId) {
    return {
      configured: false,
      error: "비공개 설치 등록부 환경 값을 모두 설정해 주세요.",
    };
  }
  if (!INSTALLATION_ID_PATTERN.test(installationId)) {
    return {
      configured: false,
      error: "SHAREDESK_INSTALLATION_ID 값이 올바르지 않습니다.",
    };
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    return {
      configured: false,
      error: "SHAREDESK_OWNER_REGISTRY_ENDPOINT 값이 올바르지 않습니다.",
    };
  }
  const isLoopbackHttp =
    endpoint.protocol === "http:" &&
    (endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]");
  if (
    (endpoint.protocol !== "https:" && !isLoopbackHttp) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    return {
      configured: false,
      error: "SHAREDESK_OWNER_REGISTRY_ENDPOINT 값이 올바르지 않습니다.",
    };
  }

  return {
    configured: true,
    endpoint: endpoint.toString(),
    installationId,
    sharedSecret,
    error: null,
  };
}

function resolveMetadata(
  requestOrigin: string,
  env: Environment,
): Omit<OwnerRegistryStatus, "enabled" | "error"> & { error: string | null } {
  let site: string;
  try {
    site = resolvePublicOrigin(requestOrigin, env);
  } catch (error) {
    return {
      version: packageMetadata.version,
      site: null,
      repository: null,
      error:
        error instanceof Error
          ? error.message
          : "설치 사이트 주소를 확인하지 못했습니다.",
    };
  }

  const repositoryResult = resolveUpdateRepository(env);
  const repositoryWasConfigured = Boolean(
    env.SHAREDESK_GITHUB_REPOSITORY?.trim() ||
      env.VERCEL_GIT_REPO_OWNER?.trim() ||
      env.VERCEL_GIT_REPO_SLUG?.trim(),
  );
  if (!repositoryResult.configured && repositoryWasConfigured) {
    return {
      version: packageMetadata.version,
      site,
      repository: null,
      error: repositoryResult.error,
    };
  }

  return {
    version: packageMetadata.version,
    site,
    repository: repositoryResult.repository,
    error: null,
  };
}

export function getOwnerRegistryStatus(
  requestOrigin: string,
  env: Environment = process.env,
): OwnerRegistryStatus {
  const config = resolveConfig(env);
  const metadata = resolveMetadata(requestOrigin, env);
  const error = config.error ?? metadata.error;
  return {
    enabled: config.configured && metadata.error === null,
    version: metadata.version,
    site: metadata.site,
    repository: metadata.repository,
    error,
  };
}

export async function recordOwnerRegistryObservation(
  requestOrigin: string,
  observedByEmail: string,
  env: Environment = process.env,
): Promise<OwnerRegistryObservation> {
  const config = resolveConfig(env);
  const status = getOwnerRegistryStatus(requestOrigin, env);
  if (!config.configured || !status.enabled || !status.site) {
    return {
      ok: false,
      status,
      error: status.error ?? "비공개 설치 등록부를 사용할 수 없습니다.",
      reason: "disabled",
    };
  }

  const observedAt = new Date().toISOString();
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sharedSecret: config.sharedSecret,
        installationId: config.installationId,
        version: status.version,
        site: status.site,
        repository: status.repository,
        observedAt,
        observedByEmail,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      created?: unknown;
    } | null;
    if (!response.ok || body?.ok !== true) {
      throw new Error(`collector returned ${response.status}`);
    }
    return {
      ok: true,
      status,
      observedAt,
      created: body.created === true,
    };
  } catch (error) {
    console.error(
      "[owner-registry] observation failed",
      error instanceof Error ? error.message : error,
    );
    return {
      ok: false,
      status,
      error: "비공개 설치 등록부에 연결하지 못했습니다.",
      reason: "upstream",
    };
  }
}
