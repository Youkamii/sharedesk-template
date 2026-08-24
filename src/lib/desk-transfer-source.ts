// 보내는 데스크에서 실제로 내용을 받아 오는 쪽. 주소 판별은 desk-transfer.ts가
// 하고, 여기서는 그 주소로 나가는 요청의 안전 규칙만 다룬다.

// 목록 응답은 짧다. 오래 매달리거나 거대한 본문을 받아 줄 이유가 없다.
const MANIFEST_TIMEOUT_MS = 15_000;
const MANIFEST_MAX_BYTES = 256 * 1024;

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
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MANIFEST_MAX_BYTES) return null;

  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length > MANIFEST_MAX_BYTES) return null;

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
