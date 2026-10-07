import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { recordEntryChangeAfter } from "@/lib/entry-audit";
import { holdsRegisteredPublicFolder } from "@/lib/public-folders";
import { getAdapter } from "@/lib/storage";
import { errorResponse, runWithEditRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  return runWithEditRights({ fresh: true }, async ({ session, space }) => {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.id !== "string") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    // 등록된 공개 폴더는 휴지통에 넣을 수 없다(#14) — 살아 있는 공개
    // 주소가 통째로 사라지는 실수를 막는다. 삭제는 하위 트리를 함께
    // 가져가므로 그 폴더의 **조상**도 같이 막는다. 관리 화면에서 등록을
    // 해제한 뒤에만 지울 수 있다. 등록부는 기본 데스크 전용이라 그
    // 문맥에서만 판정한다(공개 폴더 안 파일 삭제는 그대로 된다).
    if (space === null && (await holdsRegisteredPublicFolder(body.id))) {
      return NextResponse.json(
        { error: "공개 폴더는 등록을 해제한 뒤에 지울 수 있습니다" },
        { status: 400 },
      );
    }
    try {
      const adapter = getAdapter();
      // 항목은 기록용 — 조회가 실패해도 삭제는 계속한다.
      const entry = await adapter.getEntry(body.id).catch(() => null);
      await adapter.remove(body.id);
      if (entry) {
        recordActivityAfter(session, "trash", entry.name);
        // 최근 파일 창(#16 C-1)이 위치를 찾지 않고 "지워짐"으로 판정하게.
        recordEntryChangeAfter(entry, session, "deleted");
      }
      return NextResponse.json({ ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
