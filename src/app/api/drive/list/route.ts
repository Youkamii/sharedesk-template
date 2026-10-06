import { NextRequest, NextResponse } from "next/server";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, runWithSession } from "@/lib/api";
import {
  getFolderEntries,
  getFolderListingWithLayout,
} from "@/lib/desktop-layout";

export async function GET(req: NextRequest) {
  return runWithSession(null, async () => {
    const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
    try {
      // layout=0: 항목만 준다(#16 C-2 폴더 아이콘의 NEW 배지 세기용 — 배치를 읽거나 쓰지 않는다).
      if (req.nextUrl.searchParams.get("layout") === "0") {
        return NextResponse.json({ entries: await getFolderEntries(folderId) });
      }
      return NextResponse.json(await getFolderListingWithLayout(folderId));
    } catch (e) {
      return errorResponse(e);
    }
  });
}
