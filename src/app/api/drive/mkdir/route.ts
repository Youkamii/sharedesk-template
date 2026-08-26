import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { isRegisteredPublicFolder } from "@/lib/public-folders";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, runWithUploadRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session, space }) => {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.name !== "string") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    const parentId =
      typeof body.parentId === "string" ? body.parentId : ROOT_ID;
    // 공개 폴더(#10)는 평평하게 유지한다 — 하위 폴더는 멤버도 못 만든다.
    // 등록부는 기본 데스크 전용이라 기본 문맥에서만 판정한다.
    if (space === null && (await isRegisteredPublicFolder(parentId))) {
      return NextResponse.json(
        { error: "공개 폴더에는 하위 폴더를 만들 수 없습니다" },
        { status: 400 },
      );
    }
    try {
      const entry = await getAdapter().createFolder(parentId, body.name);
      recordActivityAfter(session, "mkdir", entry.name);
      return NextResponse.json({ entry }, { status: 201 });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
