import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import { revokeDrivePermissionsForTargetUser } from "@/lib/drive-shares";
import { USER_ROLES, type UserRole } from "@/lib/roles";
import {
  UserStatus,
  isAdminEmail,
  listUsers,
  removeUser,
  revokeDeviceSession,
  revokeSessions,
  setStatus,
  setUserRole,
} from "@/lib/users";

async function revokeManagedShares(id: string): Promise<string | null> {
  try {
    const result = await revokeDrivePermissionsForTargetUser(id);
    if (result.failed === 0) return null;
    return `앱 접근은 막았지만 Google Drive 공유 ${result.failed}개를 회수하지 못했습니다. 다시 시도해 주세요.`;
  } catch (error) {
    console.error("[share] 사용자 권한 일괄 회수 실패", {
      targetUserId: id,
      error,
    });
    return "앱 접근은 막았지만 Google Drive 공유 권한을 확인하지 못했습니다. 다시 시도해 주세요.";
  }
}

export async function GET() {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const stored = await listUsers();
  // 화면에 보이는 관리자 표시도 환경변수를 따른다 (명단 파일과 어긋나도 환경변수가 우선).
  // 스프레드로 nickname·nicknameHistory(시각 포함)도 그대로 내려간다 —
  // 관리자 화면이 구글 이름과 닉, 닉 변경 기록을 함께 보는 근거 데이터다(#13).
  const users = stored.map((u) => ({ ...u, isAdmin: isAdminEmail(u.email) }));
  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!id || !action) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  try {
    if (action === "block" || action === "pending") {
      const status: UserStatus = action === "block" ? "blocked" : "pending";
      const user = await setStatus(id, status);
      if (!user) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      const warning = await revokeManagedShares(id);
      return NextResponse.json({ user, warning });
    }
    if (action === "revoke") {
      const user = await revokeSessions(id);
      if (!user) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      return NextResponse.json({ user });
    }
    if (action === "revoke-session") {
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json(
          { error: "끊을 로그인 세션을 확인해 주세요" },
          { status: 400 },
        );
      }
      const result = await revokeDeviceSession(id, sessionId);
      if (!result) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      if (!result.revoked) {
        return NextResponse.json(
          { error: "이미 끊겼거나 없는 로그인입니다" },
          { status: 404 },
        );
      }
      return NextResponse.json({ user: result.user });
    }
    if (action === "remove") {
      // 삭제 전에 세션을 먼저 끊는다. Drive 권한 일부가 회수되지 않더라도 앱 접근까지
      // 열린 채로 남겨두지 않고, 차단 상태로 보존해 관리자가 다시 시도할 수 있게 한다.
      const blocked = await setStatus(id, "blocked");
      if (!blocked) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      const warning = await revokeManagedShares(id);
      if (warning) {
        return NextResponse.json({ user: blocked, removed: false, warning });
      }
      const ok = await removeUser(id);
      if (!ok) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "처리하지 못했습니다" },
      { status: 400 },
    );
  }
  return NextResponse.json({ error: "알 수 없는 동작입니다" }, { status: 400 });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!id || !action) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  try {
    if (action === "role") {
      const role = typeof body?.role === "string" ? body.role : "";
      if (!(USER_ROLES as readonly string[]).includes(role)) {
        return NextResponse.json(
          { error: "역할 값을 확인해 주세요" },
          { status: 400 },
        );
      }
      const user = await setUserRole(id, role as UserRole);
      if (!user) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      console.info("[admin]", {
        event: "role-changed",
        targetUserId: user.id,
        role: user.role,
        actorUserId: auth.session.userId,
      });
      return NextResponse.json({ user });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "처리하지 못했습니다" },
      { status: 400 },
    );
  }
  return NextResponse.json({ error: "알 수 없는 동작입니다" }, { status: 400 });
}
