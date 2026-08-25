import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireAdmin } from "@/lib/api";
import { resolveUserRole } from "@/lib/roles";
import { runWithSpace } from "@/lib/space-context";
import { getSpace } from "@/lib/spaces";
import { findUserById, listUsers, removeUser, upsertSpaceMember } from "@/lib/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 스페이스 멤버 관리 (#12). admin 전용.
//
// 가입은 기본 데스크에서만 일어난다(기존 초대 코드 흐름 그대로). 스페이스
// 멤버십은 이미 가입한 사용자를 관리자가 명단에 넣는 방식이다 — 정체·세션은
// 기본 데스크가 진실 원천이고 여기 명단은 멤버십·역할만 뜻한다.

async function requireSpace(slug: string) {
  const space = await runWithSpace(null, () => getSpace(slug));
  if (!space) return null;
  return { slug: space.slug, folderId: space.folderId };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const space = await requireSpace((await params).slug);
  if (!space) {
    return NextResponse.json(
      { error: "스페이스를 찾을 수 없습니다" },
      { status: 404 },
    );
  }
  const members = await runWithSpace(space, () => listUsers());
  return NextResponse.json(
    {
      members: members.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const space = await requireSpace((await params).slug);
  if (!space) {
    return NextResponse.json(
      { error: "스페이스를 찾을 수 없습니다" },
      { status: 404 },
    );
  }
  const body = (await req.json().catch(() => null)) as {
    userId?: unknown;
    role?: unknown;
  } | null;
  if (!body || typeof body.userId !== "string") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  try {
    // 기본 데스크에 실제로 가입된 사용자만 넣을 수 있다 — 정체의 진실 원천.
    const base = await runWithSpace(null, () =>
      findUserById(body.userId as string, { fresh: true }),
    );
    if (!base || base.status !== "approved") {
      return NextResponse.json(
        { error: "기본 데스크에 없는 사용자입니다" },
        { status: 404 },
      );
    }
    const member = await runWithSpace(space, () =>
      upsertSpaceMember(
        { id: base.id, email: base.email, name: base.name },
        resolveUserRole(body.role),
      ),
    );
    return NextResponse.json(
      {
        member: {
          id: member.id,
          email: member.email,
          name: member.name,
          role: member.role,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  const space = await requireSpace((await params).slug);
  if (!space) {
    return NextResponse.json(
      { error: "스페이스를 찾을 수 없습니다" },
      { status: 404 },
    );
  }
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  try {
    const removed = await runWithSpace(space, () => removeUser(userId));
    return NextResponse.json({ removed });
  } catch (e) {
    return errorResponse(e);
  }
}
