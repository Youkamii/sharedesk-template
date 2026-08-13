import type { NextRequest } from "next/server";
import { errorResponse, requireSession } from "@/lib/api";
import { searchStorage } from "@/lib/search";
import { ROOT_ID } from "@/lib/storage/types";

export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;

  const query = req.nextUrl.searchParams.get("query") ?? "";
  const folderId = req.nextUrl.searchParams.get("folderId") ?? ROOT_ID;
  try {
    return Response.json(
      await searchStorage(query, folderId, undefined, { signal: req.signal }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
