import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithSession } from "@/lib/api";
import { getEntryAudit } from "@/lib/entry-audit";
import { getAdapter } from "@/lib/storage";

// 항목 속성(#14) — 일반 데스크의 "속성"과 같은 자리. 이름·크기·수정일은
// 목록에도 있지만 여기서 저장소의 지금 값을 다시 읽어 준다(목록이 낡았을 수
// 있다). 누가 올렸는지는 항목별 내력에서, 누가 받아 갔는지는 관리자에게만.
export async function GET(req: NextRequest) {
  return runWithSession(null, async ({ session }) => {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id가 필요합니다" }, { status: 400 });
    }
    try {
      const entry = await getAdapter().getEntry(id);
      const audit = await getEntryAudit(entry.layoutKey);
      const admin = session.role === "admin";
      return NextResponse.json({
        entry: {
          id: entry.id,
          name: entry.name,
          isFolder: entry.isFolder,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          mimeType: entry.mimeType,
        },
        uploadedBy: audit?.uploadedBy ?? null,
        uploadedAt: audit?.uploadedAt ?? null,
        // 공개 폴더 방문자가 올렸다(#17 B-4) — 화면이 "손님 · 이름"으로 보인다.
        uploadedByGuest: audit?.uploadedByGuest === true,
        // 내려받기 기록은 "누가 내 파일을 가져갔나"라서 관리자만 본다.
        downloadCount: admin ? (audit?.downloadCount ?? 0) : null,
        downloads: admin ? (audit?.downloads ?? []) : null,
        // 그중 공유 링크로 받아 간 횟수·마지막 시각(#17 B-7).
        linkDownloadCount: admin ? (audit?.linkDownloadCount ?? 0) : null,
        lastLinkDownloadAt: admin ? (audit?.lastLinkDownloadAt ?? null) : null,
      });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
