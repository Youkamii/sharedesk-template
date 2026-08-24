// 보내는 데스크에서 실제로 내용을 받아 오는 쪽. 주소 판별은 desk-transfer.ts가
// 하고, 여기서는 그 주소로 나가는 요청의 안전 규칙만 다룬다.
//
// 서버 전용 파일이다 — node:dns를 쓴다.

import { lookup } from "node:dns/promises";

// 목록 응답은 짧다. 오래 매달리거나 거대한 본문을 받아 줄 이유가 없다.
const MANIFEST_TIMEOUT_MS = 15_000;
const MANIFEST_MAX_BYTES = 256 * 1024;

// 이름 모양만 봐서는 내부망을 막지 못한다. 127.0.0.1.nip.io처럼 평범한 공개
// 도메인이 루프백으로 해석되거나, 사내 DNS가 공인 도메인을 사설 IP로 돌리는
// 구성이 흔하다. 실제로 해석되는 주소를 보고 판단한다.
export function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  // 클라우드 메타데이터(169.254.169.254)를 포함한 링크로컬.
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  // 통신사 대규모 NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 멀티캐스트와 예약 대역.
  if (a >= 224) return true;
  return false;
}

export function isBlockedIpv6(address: string): boolean {
  const host = address.toLowerCase().split("%")[0];
  if (host === "::1" || host === "::") return true;
  // 링크로컬(fe80::/10)과 유니크 로컬(fc00::/7).
  if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

/**
 * 호스트 이름이 공개 인터넷 주소로 해석되는지 확인한다.
 *
 * 해석 시점과 실제 접속 시점 사이에 DNS가 바뀌는 재바인딩까지는 막지 못한다.
 * 완전히 막으려면 확인한 IP로 직접 접속해야 하는데 그러면 TLS 인증서 검증이
 * 어긋난다. 여기서는 평범한 오지정과 알려진 우회 도메인을 막는 데 목적을 둔다.
 */
export async function resolvesToPublicAddress(
  hostname: string,
): Promise<boolean> {
  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (resolved.length === 0) return false;
  return resolved.every((entry) =>
    entry.family === 6
      ? !isBlockedIpv6(entry.address)
      : !isBlockedIpv4(entry.address),
  );
}

export interface ManifestEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string | null;
}

export interface Manifest {
  kind: "file" | "folder";
  name: string;
  size: number | null;
  mimeType: string | null;
  entries: ManifestEntry[] | null;
}

// 검증을 통과한 주소가 내부망으로 리다이렉트하면 검증이 무의미해진다.
// 리다이렉트는 따라가지 않고 실패로 본다.
export const DESK_FETCH_BASE = {
  redirect: "error" as const,
  cache: "no-store" as const,
};

/**
 * 본문을 읽으면서 바이트를 세고 상한을 넘으면 즉시 끊는다.
 * Content-Length는 안 줄 수도, 거짓일 수도 있으므로 헤더만 믿지 않는다.
 * text()로 먼저 받으면 상한을 재기 전에 이미 전부 메모리에 올라간다.
 */
async function readLimitedText(
  response: Response,
  limit: number,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function describeEntry(value: unknown): ManifestEntry | null {
  const raw = value as Partial<ManifestEntry>;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.name !== "string" || !raw.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    isFolder: raw.isFolder === true,
    size:
      typeof raw.size === "number" &&
      Number.isSafeInteger(raw.size) &&
      raw.size >= 0
        ? raw.size
        : null,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : null,
  };
}

/**
 * 보내는 데스크의 목록 응답을 읽는다. 상대는 남의 서버이므로 형태를 하나도
 * 믿지 않고 필요한 값만 추려 낸다. 읽지 못하면 null이다.
 */
export async function readManifest(url: string): Promise<Manifest | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...DESK_FETCH_BASE,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  const text = await readLimitedText(response, MANIFEST_MAX_BYTES);
  if (text === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = value as Partial<Manifest> & { entries?: unknown };
  if (raw?.kind !== "file" && raw?.kind !== "folder") return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;

  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(describeEntry).filter((entry): entry is ManifestEntry =>
        Boolean(entry),
      )
    : null;

  return {
    kind: raw.kind,
    name: raw.name,
    size:
      typeof raw.size === "number" &&
      Number.isSafeInteger(raw.size) &&
      raw.size >= 0
        ? raw.size
        : null,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : null,
    entries,
  };
}
