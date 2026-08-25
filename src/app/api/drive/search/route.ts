import type { NextRequest } from "next/server";
import { errorResponse, runWithSession } from "@/lib/api";
import { searchStorage } from "@/lib/search";
import { ROOT_ID } from "@/lib/storage/types";

export async function GET(req: NextRequest) {
  return runWithSession(null, async () => {
    const query = req.nextUrl.searchParams.get("query") ?? "";
    const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
    try {
      return Response.json(
        await searchStorage(query, folderId, undefined, { signal: req.signal }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
