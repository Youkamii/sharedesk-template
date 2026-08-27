import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { holdsRegisteredPublicFolder } from "@/lib/public-folders";
import { getAdapter } from "@/lib/storage";
import { errorResponse, runWithEditRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  return runWithEditRights({ fresh: true }, async ({ session, space }) => {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.id !== "string" ||
      typeof body.name !== "string" ||
      typeof body.expectedVersion !== "string"
    ) {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    // 공개 폴더(#10)와 그 조상은 이름을 바꿀 수 없다 — local의 폴더 id는
    // 경로 기반이라 자신이든 부모든 이름이 바뀌면 등록이 끊긴다(#14 15와
    // 같은 이유). 기본 데스크 문맥에서만 판정.
    if (space === null && (await holdsRegisteredPublicFolder(body.id))) {
      return NextResponse.json(
        { error: "공개 폴더는 이동하거나 이름을 바꿀 수 없습니다" },
        { status: 400 },
      );
    }
    try {
      const entry = await getAdapter().rename(
        body.id,
        body.name,
        body.expectedVersion,
      );
      recordActivityAfter(session, "rename", entry.name);
      return NextResponse.json({ entry });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
