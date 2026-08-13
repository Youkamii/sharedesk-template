// 토큰 서명·검증만 담당한다. 저장소를 건드리지 않으므로 edge(proxy)에서도 돌아간다.
// "이 사람이 아직 승인 상태인가"는 여기서 판정하지 않는다 — auth.ts의 resolveSession이 한다.

const enc = new TextEncoder();

export const COOKIE_NAME = "sharedesk_session";
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 90;
export const MAX_SESSION_ID_LENGTH = 64;
const CLOCK_SKEW_SECONDS = 300;
const MIN_SESSION_ID_LENGTH = 20;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type Payload =
  // 구글 로그인 등으로 인증된 사용자 세션
  | { t: "user"; sub: string; sv?: number; sid?: string; iat: number }
  // ACCESS_KEYS를 쓰는 임시 손님 세션 (키가 설정된 경우에만 발급)
  | { t: "key"; k: string; sid?: string; iat: number };

export function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_SESSION_ID_LENGTH &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(value)
  );
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function getAccessKeys(): string[] {
  return (process.env.ACCESS_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// 비밀이 없으면 서명할 수 없다. 예외를 던져 fail-closed로 간다.
// 접속 키에서 파생하는 폴백은 두지 않는다 — 손님에게 나눠준 값이 서명 비밀이 되면
// 쿠키 하나로 오프라인 대입이 가능해지고, 키를 회수할 때 전원의 세션이 함께 끊긴다.
function secretMaterial(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "SESSION_SECRET이 없거나 너무 짧습니다 — npm run setup으로 생성하세요",
    );
  }
  return s;
}

let cached: { material: string; key: Promise<CryptoKey> } | null = null;
function getHmacKey(): Promise<CryptoKey> {
  const material = secretMaterial();
  if (!cached || cached.material !== material) {
    cached = {
      material,
      key: crypto.subtle.importKey(
        "raw",
        enc.encode(material),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    };
  }
  return cached.key;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signPayload(payload: Payload): Promise<string> {
  const body = enc.encode(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await getHmacKey(), body),
  );
  return `${toB64Url(body)}.${toB64Url(sig)}`;
}

// 서명과 시각만 확인한다. 통과했다고 접근 권한이 있는 것은 아니다.
export async function openSigned(
  token: string | undefined | null,
): Promise<Payload | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = fromB64Url(token.slice(0, dot));
  const sig = fromB64Url(token.slice(dot + 1));
  if (!body || !sig) return null;
  let hmacKey: CryptoKey;
  try {
    hmacKey = await getHmacKey();
  } catch {
    return null;
  }
  if (!(await crypto.subtle.verify("HMAC", hmacKey, sig, body))) return null;
  let claims: Payload;
  try {
    claims = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof claims?.iat !== "number") return null;
  if (claims.t !== "user" && claims.t !== "key") return null;
  if (claims.t === "user") {
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (
      claims.sv !== undefined &&
      (!Number.isSafeInteger(claims.sv) || claims.sv < 0)
    ) {
      return null;
    }
    if (claims.sid !== undefined && !isValidSessionId(claims.sid)) return null;
  } else {
    if (typeof claims.k !== "string" || !claims.k) return null;
    if (claims.sid !== undefined && !isValidSessionId(claims.sid)) return null;
  }
  const now = Date.now() / 1000;
  if (claims.iat > now + CLOCK_SKEW_SECONDS) return null;
  if (claims.iat + MAX_AGE_SECONDS <= now) return null;
  return claims;
}
