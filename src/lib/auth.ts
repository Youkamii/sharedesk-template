// 세션의 현재 유효성을 판정한다 (Node 런타임 전용 — 명단 조회가 저장소를 쓴다).
//
// 토큰은 서명된 자기완결 토큰(JWT와 동등한 구조)이지만, 검증 때 "이 사람이 아직
// 승인 상태인가"를 반드시 조회한다. 조회 없이 토큰만 믿으면 관리자가 승인을 취소해도
// 이미 발급된 세션이 만료까지 살아남는다 — 이 제품에서 실제로 겪은 결함이다(#1).
// 그래서 만료는 길게 두고(90일), 끊는 책임은 명단 조회가 진다.

import { randomUUID } from "node:crypto";
import { resolveUserRole, type SessionRole } from "@/lib/roles";
import { findUserById, isAdminEmail, type User } from "@/lib/users";
import {
  Payload,
  getAccessKeys,
  isValidSessionId,
  openSigned,
  sha256Hex,
  signPayload,
} from "@/lib/session-token";

export { COOKIE_NAME, MAX_AGE_SECONDS } from "@/lib/session-token";

export interface SessionInfo {
  userId: string;
  email: string;
  name: string;
  isAdmin: boolean;
  isGuest: boolean;
  // 파일 권한 판정용 세션 역할 — ADMIN_EMAILS 사용자는 저장 역할과 무관하게
  // "admin", 접속 키 손님은 "viewer", 그 외에는 users.json의 저장 역할.
  role: SessionRole;
  presenceParticipantId: string;
  presenceLeaseId: string;
}

export interface IdentityInfo {
  userId: string;
  email: string;
  name: string;
  status: User["status"];
  isAdmin: boolean;
}

export async function createUserSession(
  userId: string,
  sessionVersion: number,
  sessionId: string,
): Promise<string> {
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
    throw new Error("올바르지 않은 세션 버전입니다");
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error("올바르지 않은 세션 ID입니다");
  }
  const payload: Payload = {
    t: "user",
    sub: userId,
    sv: sessionVersion,
    sid: sessionId,
    iat: Math.floor(Date.now() / 1000),
  };
  return signPayload(payload);
}

function userClaimsAreCurrent(
  claims: Extract<Payload, { t: "user" }>,
  user: User,
): boolean {
  if (
    (claims.sv === undefined && user.sessionVersion !== 0) ||
    (claims.sv !== undefined && claims.sv !== user.sessionVersion)
  ) {
    return false;
  }
  if (claims.iat * 1000 < user.sessionsValidFrom) return false;
  if (claims.sid !== undefined) {
    return user.sessions.some((session) => session.id === claims.sid);
  }
  // 기존 sid 없는 쿠키는 마이그레이션 동안 유지한다. 개별 식별은 불가능하므로
  // 세션 버전 변경(전체 끊기·차단·대기)과 발급 시각으로만 무효화한다.
  return true;
}

export async function createKeySession(
  keyHash: string,
  sessionId = randomUUID(),
): Promise<string> {
  const payload: Payload = {
    t: "key",
    k: keyHash.slice(0, 32),
    sid: sessionId,
    iat: Math.floor(Date.now() / 1000),
  };
  return signPayload(payload);
}

// fresh: 명단 캐시를 건너뛰고 최신 상태를 읽는다. 화면 진입 판정처럼 "차단이 즉시
// 반영되어야 하는" 자리에서 쓴다. 파일 API처럼 잦은 호출은 캐시를 그대로 쓴다.
export async function resolveSession(
  token: string | undefined | null,
  opts?: { fresh?: boolean },
): Promise<SessionInfo | null> {
  const claims = await openSigned(token);
  if (!claims) return null;

  if (claims.t === "user") {
    const user = await findUserById(claims.sub, opts);
    if (!user || user.status !== "approved") return null;
    if (!userClaimsAreCurrent(claims, user)) return null;
    // 관리자 판정은 명단 파일이 아니라 환경변수를 진실 원천으로 삼는다.
    // 저장소의 users.json이 어떤 이유로든 바뀌어도 권한이 따라 올라가지 않는다.
    const isAdmin = isAdminEmail(user.email);
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      isAdmin,
      isGuest: false,
      role: isAdmin ? "admin" : resolveUserRole(user.role),
      presenceParticipantId: `user:${user.id}`,
      presenceLeaseId:
        claims.sid ?? `legacy:${(await sha256Hex(token ?? "")).slice(0, 32)}`,
    };
  }

  // 키 세션: 그 키가 아직 ACCESS_KEYS에 남아 있어야 유효.
  for (const key of getAccessKeys()) {
    if ((await sha256Hex(key)).slice(0, 32) === claims.k) {
      return {
        userId: "key:" + claims.k.slice(0, 8),
        email: "",
        name: "손님",
        isAdmin: false,
        isGuest: true,
        role: "viewer",
        presenceParticipantId: `guest:${
          claims.sid ?? (await sha256Hex(token ?? "")).slice(0, 32)
        }`,
        presenceLeaseId:
          claims.sid ?? `legacy:${(await sha256Hex(token ?? "")).slice(0, 32)}`,
      };
    }
  }
  return null;
}

// 승인 여부와 무관하게 "이 토큰의 주인이 누구인가"만 알아낸다.
// 승인 대기 화면이 본인 이름을 보여주는 용도이며, 접근 허용에는 쓰지 않는다.
export async function resolveIdentity(
  token: string | undefined | null,
): Promise<IdentityInfo | null> {
  const claims = await openSigned(token);
  if (!claims || claims.t !== "user") return null;
  const user = await findUserById(claims.sub, { fresh: true });
  if (!user) return null;
  if (!userClaimsAreCurrent(claims, user)) return null;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    isAdmin: isAdminEmail(user.email),
  };
}

// 문자열 직접 비교 대신 해시끼리 비교해 타이밍 누출을 막는다.
export async function matchKey(submitted: string): Promise<string | null> {
  const target = await sha256Hex(submitted);
  let matched: string | null = null;
  for (const key of getAccessKeys()) {
    if ((await sha256Hex(key)) === target) matched = target;
  }
  return matched;
}
