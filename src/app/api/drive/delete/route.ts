import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { getAdapter } from "@/lib/storage";
import { errorResponse, runWithEditRights } from "@/lib/api";

export async function POST(req: NextRequest) {
  return runWithEditRights({ fresh: true }, async ({ session }) => {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.id !== "string") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    try {
      const adapter = getAdapter();
      // 이름은 기록용 — 조회가 실패해도 삭제는 계속한다.
      const name = await adapter
        .getEntry(body.id)
        .then((entry) => entry.name)
        .catch(() => null);
      await adapter.remove(body.id);
      if (name) recordActivityAfter(session, "trash", name);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  });
}
