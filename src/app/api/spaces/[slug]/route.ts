import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithAdmin } from "@/lib/api";
import { runWithSpace } from "@/lib/space-context";
import { getSpace, removeSpace, renameSpace } from "@/lib/spaces";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 스페이스 이름 변경·삭제 (#12). admin 전용. 등록부 조회·변경은 기본 문맥에서.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  return runWithAdmin({ fresh: true }, async () => {
    const { slug } = await params;
    const body = (await req.json().catch(() => null)) as {
      name?: unknown;
    } | null;
    if (!body || typeof body.name !== "string") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    try {
      const renamed = await runWithSpace(null, () =>
        renameSpace(slug, body.name as string),
      );
      if (!renamed) {
        return NextResponse.json(
          { error: "스페이스를 찾을 수 없습니다" },
          { status: 404 },
        );
      }
      return NextResponse.json({ space: renamed });
    } catch (e) {
      return errorResponse(e);
    }
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  return runWithAdmin({ fresh: true }, async () => {
    const { slug } = await params;
    try {
      const existing = await runWithSpace(null, () => getSpace(slug));
      if (!existing) {
        return NextResponse.json(
          { error: "스페이스를 찾을 수 없습니다" },
          { status: 404 },
        );
      }
      // 등록부에서만 뺀다. 파일은 저장소에 그대로 남는다 — 데이터 삭제는
      // 관리자가 저장소에서 직접, 명시적으로만 한다. 등록이 사라지면 그
      // 주소는 즉시 404가 된다.
      await runWithSpace(null, () => removeSpace(slug));
      return NextResponse.json({ removed: true, filesKept: true });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
