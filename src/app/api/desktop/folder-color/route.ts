import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import { parseFolderColor } from "@/lib/folder-color-ids";
import { setFolderColor } from "@/lib/folder-colors";
import { getAdapter } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 폴더 색(#14)·파일 라벨 색(#16 C-7) 지정. 배치 저장과 같은 upload 권한 — 화면
// 꾸밈은 올릴 수 있는 사람 누구나 만진다. 색은 layoutKey(항목 identity)에 저장돼
// 옮기거나 이름을 바꿔도 따라간다. 파일도 같은 저장소(folder-colors.json)를 쓴다.
export async function PATCH(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async () => {
    const body = (await req.json().catch(() => null)) as {
      id?: unknown;
      color?: unknown;
    } | null;
    if (!body || typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    const color = body.color === null ? null : parseFolderColor(body.color);
    if (color === null && body.color !== null) {
      return NextResponse.json(
        { error: "색 값을 확인해 주세요" },
        { status: 400 },
      );
    }
    try {
      // 있는 항목인지(그리고 지금 데스크 안인지)만 확인한다 — 폴더·파일 모두 받는다.
      const entry = await getAdapter().getEntry(body.id);
      const colors = await setFolderColor(entry.layoutKey, color);
      return NextResponse.json(
        { colors },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
