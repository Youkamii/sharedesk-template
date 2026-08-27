import { NextRequest, NextResponse } from "next/server";
import {
  COOKIE_NAME,
  openSigned,
} from "@/lib/session-token";
import { parseInvitationCode } from "@/lib/invite-token";
import { runWithSpace } from "@/lib/space-context";
import { redeemInvitationForUser } from "@/lib/users";

const MAX_BODY_BYTES = 4_096;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_USER = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(userId: string): boolean {
  const now = Date.now();
  const current = attempts.get(userId);
  if (!current || now > current.resetAt) {
    attempts.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    if (attempts.size > 1_000) {
      for (const [id, value] of attempts) {
        if (now > value.resetAt) attempts.delete(id);
      }
    }
    return false;
  }
  current.count += 1;
  return current.count > MAX_ATTEMPTS_PER_USER;
}

function redirect(req: NextRequest, path: string, reason?: string) {
  const url = new URL(path, req.url);
  if (reason) url.searchParams.set("error", reason);
  return NextResponse.redirect(url, 303);
}

async function readCode(req: NextRequest): Promise<string | null> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_BODY_BYTES
    ) {
      return null;
    }
  }

  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return new URLSearchParams(raw).get("code");
  }
  if (!contentType.startsWith("application/json")) {
    return null;
  }
  try {
    const body = JSON.parse(raw) as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

// 공개 라우트(가입 절차) — 초대 소비는 언제나 기본 데스크에서 일어나므로
// 기본 문맥을 명시한다.
export async function POST(req: NextRequest) {
  return runWithSpace(null, async () => {
    const claims = await openSigned(req.cookies.get(COOKIE_NAME)?.value);
    if (!claims || claims.t !== "user") {
      return redirect(req, "/", "invite_required");
    }
    if (tooManyAttempts(claims.sub)) {
      return redirect(req, "/join", "invite_rate_limited");
    }
    const invitation = parseInvitationCode(await readCode(req));
    if (!invitation) return redirect(req, "/join", "invite_invalid");
    const redeemed = await redeemInvitationForUser(
      claims.sub,
      invitation,
      {
        issuedAtSeconds: claims.iat,
        sessionVersion: claims.sv,
        sessionId: claims.sid,
      },
    );
    if (!redeemed.ok) return redirect(req, "/join", redeemed.reason);
    // 승인 직후에도 로그인과 같은 목적지 — 데스크 선택(/spaces)이 전 단계다(#14).
    return redirect(req, "/spaces");
  });
}
