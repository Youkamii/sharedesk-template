import { NextRequest, NextResponse } from "next/server";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, runWithSession } from "@/lib/api";
import { getFolderListingWithLayout } from "@/lib/desktop-layout";

export async function GET(req: NextRequest) {
  return runWithSession(null, async () => {
    const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
    try {
      return NextResponse.json(await getFolderListingWithLayout(folderId));
    } catch (e) {
      return errorResponse(e);
    }
  });
}
