import { NextResponse } from "next/server";
import { listActivity } from "@/lib/activity";
import { errorResponse, requireAdmin } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;
  try {
    return NextResponse.json(
      { entries: await listActivity() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
