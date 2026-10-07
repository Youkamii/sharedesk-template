import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithSession } from "@/lib/api";
import { parseRecentQuery } from "@/lib/recent-files";
import { loadRecentFiles } from "@/lib/recent-files-load";

// 최근 파일(#16 C-1) — 최근 N일의 업로드·내용 수정·이름 변경·이동을 시간 역순으로.
// 관리자 전용이 아니다: 이 데스크(스페이스)의 멤버면 누구나 본다(올린 사람은 속성
// 창에서도 누구나 보는 정보다 — 받아 간 기록은 담지 않는다). 스페이스 문맥은
// 러너가 세우므로 내력 파일과 위치 찾기 모두 그 스페이스 저장소만 본다.
export async function GET(req: NextRequest) {
  return runWithSession(null, async () => {
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
