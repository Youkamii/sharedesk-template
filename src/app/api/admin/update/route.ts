import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import { getUpdateStatus } from "@/lib/update-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const status = await getUpdateStatus();
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
