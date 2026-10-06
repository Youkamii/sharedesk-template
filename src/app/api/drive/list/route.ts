import { NextRequest, NextResponse } from "next/server";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, runWithSession } from "@/lib/api";
import { getFolderListingWithLayout } from "@/lib/desktop-layout";
import { getAdapter } from "@/lib/storage";

export async function GET(req: NextRequest) {
  return runWithSession(null, async () => {
    const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
    try {
      // layout=0: 항목만 준다(#16 C-2 폴더 아이콘의 NEW 배지 세기용). 배치 상태를 읽지도,
      // 처음 배치를 저장하지도 않는다 — 열어 보지 않은 폴더에 배치 파일이 생기지 않게.
      if (req.nextUrl.searchParams.get("layout") === "0") {
        return NextResponse.json({ entries: await getAdapter().list(folderId) });
      }
      return NextResponse.json(await getFolderListingWithLayout(folderId));
    } catch (e) {
      return errorResponse(e);
    }
  });
}
