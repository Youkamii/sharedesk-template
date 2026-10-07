import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithSession } from "@/lib/api";
import { parseRecentQuery } from "@/lib/recent-files";
import { loadRecentFiles } from "@/lib/recent-files-load";

// 최근 파일(#16 C-1) — 최근 N일의 업로드·내용 수정·이름 변경·이동을 시간 역순으로.
// 이 데스크(스페이스)의 멤버만 본다(보기 전용 포함, 관리자 전용 아님). 접속 키
// 손님은 누가 무엇을 바꿨는지 볼 수 없다(403). 행위자는 별명 또는 "멤버"로만 나가고
// 받아 간 기록은 담지 않는다. 스페이스 문맥은 러너가 세우므로 내력 파일과 위치
// 찾기 모두 그 스페이스 저장소만 본다.
export async function GET(req: NextRequest) {
  return runWithSession(null, async ({ session }) => {
    if (session.isGuest) {
      return NextResponse.json(
        { error: "이 작업을 할 권한이 없습니다" },
        { status: 403 },
      );
    }
    const query = parseRecentQuery(req.nextUrl.searchParams);
    if (!query) {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    try {
      return NextResponse.json(
        await loadRecentFiles(query, { signal: req.signal }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
