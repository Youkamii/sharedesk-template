import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import {
  UserStatus,
  isAdminEmail,
  listUsers,
  removeUser,
  revokeSessions,
  setStatus,
} from "@/lib/users";

export async function GET() {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const stored = await listUsers();
  // 화면에 보이는 관리자 표시도 환경변수를 따른다 (명단 파일과 어긋나도 환경변수가 우선).
  const users = stored.map((u) => ({ ...u, isAdmin: isAdminEmail(u.email) }));
  return NextResponse.json({ users, me: auth.session.userId });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!id || !action) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  try {
    if (action === "approve" || action === "block" || action === "pending") {
      const status: UserStatus =
        action === "approve"
          ? "approved"
          : action === "block"
            ? "blocked"
            : "pending";
      const user = await setStatus(id, status);
      if (!user) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      return NextResponse.json({ user });
    }
    if (action === "revoke") {
      const user = await revokeSessions(id);
      if (!user) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      return NextResponse.json({ user });
    }
    if (action === "remove") {
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
