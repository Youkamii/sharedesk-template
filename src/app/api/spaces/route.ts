import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithAdmin, runWithSession } from "@/lib/api";
import { runWithSpace } from "@/lib/space-context";
import { addSpace, listSpaces, parseSpaceSlug } from "@/lib/spaces";
import { getAdapter } from "@/lib/storage";
import { findUserById } from "@/lib/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 스페이스 목록·생성 (#12). 목록은 "내가 들어갈 수 있는 곳"만 준다 —
// 초대받지 않은 스페이스는 존재도 알리지 않는다.
export async function GET() {
  return runWithSession({ fresh: true }, async ({ session }) => {
    // 목록·멤버십 판정은 기본 문맥 기준으로 시작한다.
    const spaces = await runWithSpace(null, () => listSpaces());

    const accessible: { slug: string; name: string }[] = [];
    for (const space of spaces) {
      if (session.isAdmin) {
        accessible.push({ slug: space.slug, name: space.name });
        continue;
      }
      if (session.isGuest) continue;
      const member = await runWithSpace(
        { slug: space.slug, folderId: space.folderId },
        () => findUserById(session.userId, { fresh: true }),
      );
      if (member && member.status === "approved") {
        accessible.push({ slug: space.slug, name: space.name });
      }
    }

    return NextResponse.json(
      {
        spaces: accessible,
        canManage: session.isAdmin,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
}

export async function POST(req: NextRequest) {
  return runWithAdmin({ fresh: true }, async ({ session }) => {
    const body = (await req.json().catch(() => null)) as {
      slug?: unknown;
      name?: unknown;
    } | null;
    if (!body || typeof body.slug !== "string" || typeof body.name !== "string") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    // 대문자 입력을 소문자로 접는다 — 어댑터·등록부가 같은 값을 봐야 한다.
    const slug = parseSpaceSlug(body.slug);
    if (!slug) {
      return NextResponse.json(
        { error: "스페이스 주소가 올바르지 않습니다" },
        { status: 400 },
      );
    }

    try {
      // 저장소 폴더를 먼저 확보하고 등록부에 넣는다. 등록이 실패해도(중복 등)
      // 폴더는 남지만, 같은 슬러그를 다시 만들면 그 폴더를 재사용하므로
      // 고아가 되지 않는다. 생성·등록은 기본 문맥에서만 한다.
      const created = await runWithSpace(null, async () => {
        const folderId = await getAdapter().createSpaceRoot(slug);
        return addSpace({
          slug,
          name: body.name as string,
          folderId,
          createdByUserId: session.userId,
        });
      });
      return NextResponse.json({ space: created }, { status: 201 });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
