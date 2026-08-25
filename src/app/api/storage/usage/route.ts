import { NextResponse } from "next/server";
import { errorResponse, runWithAdmin } from "@/lib/api";
import { getStorageStatus } from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return runWithAdmin({ fresh: true }, async () => {
    try {
      return NextResponse.json(await getStorageStatus(true), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
