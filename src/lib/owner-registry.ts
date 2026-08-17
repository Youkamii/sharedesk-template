import "server-only";

import { createHash } from "node:crypto";
import packageMetadata from "../../package.json";
import { resolvePublicOrigin } from "@/lib/public-origin";
import { resolveUpdateRepository } from "@/lib/update-status";

type Environment = Readonly<Record<string, string | undefined>>;

type RegistryConfig =
  | {
      configured: true;
      endpoint: string;
      installationId: string;
      sharedSecret: string;
      error: null;
      unset?: undefined;
    }
  | {
      configured: false;
      error: string;
      // 두 환경 변수 모두 비어 있는 "선택 기능 미사용" 상태.
      // 값을 넣었는데 틀린 설정 오류와 구분해 화면 노출을 다르게 한다.
      unset?: boolean;
    };

export interface OwnerRegistryStatus {
  enabled: boolean;
  unset: boolean;
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

export type OwnerFeedbackResult =
  | { ok: true; sentAt: string }
  | {
      ok: false;
      error: string;
      reason: "disabled" | "upstream";
    };

const INSTALLATION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID_CONTEXT = "sharedesk-installation-id-v1:";

function isInstallationSecret(value: string): boolean {
  if (!INSTALLATION_SECRET_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

function deriveInstallationId(sharedSecret: string): string {
  const digest = createHash("sha256")
    .update(INSTALLATION_ID_CONTEXT, "utf8")
    .update(Buffer.from(sharedSecret, "base64url"))
    .digest("base64url");
  return `sd1_${digest}`;
}

function resolveConfig(env: Environment): RegistryConfig {
  const endpointValue = env.SHAREDESK_OWNER_REGISTRY_ENDPOINT?.trim() ?? "";
  const sharedSecret = env.SHAREDESK_OWNER_REGISTRY_SECRET ?? "";

  if (!endpointValue && !sharedSecret) {
    return {
      configured: false,
      unset: true,
      error: "비공개 설치 등록부가 설정되지 않았습니다.",
    };
  }
  if (!endpointValue || !sharedSecret) {
    return {
      configured: false,
      error: "비공개 설치 등록부 URL과 설치 비밀을 모두 설정해 주세요.",
    };
  }
  if (!isInstallationSecret(sharedSecret)) {
    return {
      configured: false,
      error:
        "SHAREDESK_OWNER_REGISTRY_SECRET에는 32바이트 base64url 값만 사용할 수 있습니다.",
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
    installationId: deriveInstallationId(sharedSecret),
    sharedSecret,
    error: null,
  };
}

export function isOwnerRegistryConfigured(
  env: Environment = process.env,
): boolean {
  return resolveConfig(env).configured;
}

function resolveMetadata(
  requestOrigin: string,
  env: Environment,
): Omit<OwnerRegistryStatus, "enabled" | "error" | "unset"> & {
  error: string | null;
} {
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
    unset: config.unset === true,
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
        kind: "observation",
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

export async function sendOwnerFeedback(
  requestOrigin: string,
  sender: { email: string; name: string },
  feedback: { feedbackId: string; subject: string; message: string },
  env: Environment = process.env,
): Promise<OwnerFeedbackResult> {
  const config = resolveConfig(env);
  const status = getOwnerRegistryStatus(requestOrigin, env);
  if (!config.configured || !status.enabled || !status.site) {
    return {
      ok: false,
      error: status.error ?? "사용자 피드백 연결이 설정되지 않았습니다.",
      reason: "disabled",
    };
  }

  const sentAt = new Date().toISOString();
  const senderEmail = sender.email.trim().toLowerCase();
  const senderName =
    sender.name.trim().slice(0, 120) || senderEmail.slice(0, 120);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        feedbackId: feedback.feedbackId,
        kind: "feedback",
        sharedSecret: config.sharedSecret,
        installationId: config.installationId,
        version: status.version,
        site: status.site,
        repository: status.repository,
        sentAt,
        senderEmail,
        senderName,
        subject: feedback.subject,
        message: feedback.message,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
    } | null;
    if (!response.ok || body?.ok !== true) {
      throw new Error(`collector returned ${response.status}`);
    }
    return { ok: true, sentAt };
  } catch (error) {
    console.error(
      "[owner-feedback] send failed",
      error instanceof Error ? error.message : error,
    );
    return {
      ok: false,
      error: "피드백 메일을 보내지 못했습니다.",
      reason: "upstream",
    };
  }
}
