import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID } from "@/lib/storage/types";
import { errorResponse, requireSession } from "@/lib/api";

export async function GET(req: NextRequest) {
  const denied = await requireSession();
  if (denied) return denied;
  const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
  try {
    const entries = await getAdapter().list(folderId);
    return NextResponse.json({ entries });
  } catch (e) {
    return errorResponse(e);
  }
}
