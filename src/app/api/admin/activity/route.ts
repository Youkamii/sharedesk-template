import { NextResponse } from "next/server";
import { listActivity } from "@/lib/activity";
import { errorResponse, runWithAdmin } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return runWithAdmin({ fresh: true }, async () => {
    try {
      return NextResponse.json(
        { entries: await listActivity() },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
