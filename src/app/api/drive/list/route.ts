import { NextRequest, NextResponse } from "next/server";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, requireSession } from "@/lib/api";
import { getFolderListingWithLayout } from "@/lib/desktop-layout";

export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
  try {
    return NextResponse.json(await getFolderListingWithLayout(folderId));
  } catch (e) {
    return errorResponse(e);
  }
}
