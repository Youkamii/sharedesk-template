import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import { parseFolderColor, setFolderColor } from "@/lib/folder-colors";
import { getAdapter } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 폴더 색 지정(#14). 배치 저장과 같은 upload 권한 — 화면 꾸밈은 올릴 수
// 있는 사람 누구나 만진다. 색은 layoutKey(폴더 identity)에 저장돼 폴더를
// 옮기거나 이름을 바꿔도 따라간다.
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
      const entry = await getAdapter().getEntry(body.id);
      if (!entry.isFolder) {
        return NextResponse.json(
          { error: "폴더에만 색을 지정할 수 있습니다" },
          { status: 400 },
        );
      }
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
