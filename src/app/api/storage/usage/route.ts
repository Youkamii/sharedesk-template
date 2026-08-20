import { NextResponse } from "next/server";
import { errorResponse, requireAdmin } from "@/lib/api";
import { getStorageStatus } from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  try {
    return NextResponse.json(await getStorageStatus(true), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
