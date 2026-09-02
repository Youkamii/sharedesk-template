import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, resolveSession } from "@/lib/auth";
import {
  getFolderListingWithLayout,
  getLayoutSnapshot,
  updateLayout,
} from "@/lib/desktop-layout";
import { runWithSpace } from "@/lib/space-context";
import { errorResponse } from "@/lib/api";
import { missing, resolveOpenPublicFolder } from "../shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 공개 폴더 아이콘 배치 변경 — 관리자 전용. 방문자 화면은 데스크 폴더의
// 저장 배치를 그대로 그리므로(GET 참조), 관리자가 공개 폴더 화면에서 끌어
// 놓은 자리가 곧 방문자가 보는 자리다. 익명 GET이 layoutKey를 내리지 않는
// 규약을 지키려고 클라이언트는 entry id만 보내고, layoutKey·현재 버전은
// 서버가 채운다(관리자 끌어놓기는 마지막 쓰기 우선).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return runWithSpace(null, async () => {
    const resolved = await resolveOpenPublicFolder(token);
    if (!resolved) return missing();
    const session = await resolveSession(
      (await cookies()).get(COOKIE_NAME)?.value,
    );
    if (!session?.isAdmin) {
      return NextResponse.json(
        { error: "관리자만 배치를 바꿀 수 있습니다" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    const body = (await req.json().catch(() => null)) as {
      id?: unknown;
      x?: unknown;
      y?: unknown;
    } | null;
    if (
      !body ||
      typeof body.id !== "string" ||
      !Number.isSafeInteger(body.x) ||
      !Number.isSafeInteger(body.y) ||
      (body.x as number) < 0 ||
      (body.y as number) < 0
    ) {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    try {
      const folderId = resolved.folder.folderId;
      // 옮기기 전에 폴더 좌표를 한 번 고정한다(데스크가 폴더를 열 때와 같은
      // 쓰기). 좌표 없는 아이콘은 화면이 빈 칸부터 채우므로, 하나를 옮기면
      // 나머지가 당겨지는 일이 생긴다 — 전부 저장해 두면 제자리에 남는다.
      // 고정 격자는 공개 화면의 기본 배치와 같은 상수라 눈에 띄는 점프가 없다.
      const listing = await getFolderListingWithLayout(folderId);
      const entries = listing.entries;
      const entry = entries.find((item) => item.id === body.id);
      if (!entry) {
        return NextResponse.json(
          { error: "현재 폴더에 없는 항목입니다" },
          { status: 404 },
        );
      }
      const before = listing.layout ?? (await getLayoutSnapshot(folderId));
      const expectedVersion = before.positions[entry.layoutKey]?.version ?? 0;
      const snapshot = await updateLayout(
        folderId,
        [
          {
            entryId: entry.id,
            expectedVersion,
            x: body.x as number,
            y: body.y as number,
          },
        ],
        session.userId,
        resolved.target.layoutKey,
      );
      // GET과 같은 꼴(entry id 재키잉)로 돌려줘 화면이 그대로 바꿔 끼운다.
      const positions: Record<string, { x: number; y: number }> = {};
      for (const item of entries) {
        const position = snapshot.positions[item.layoutKey];
        if (position) positions[item.id] = { x: position.x, y: position.y };
      }
      return NextResponse.json(
        { positions },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (e) {
      return errorResponse(e);
    }
  });
}
