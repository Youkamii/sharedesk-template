import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import { cleanupExpiredShareLinks } from "@/lib/share-links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  const scheduled =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  if (!scheduled) {
    const auth = await requireAdmin({ fresh: true });
    if ("response" in auth) return auth.response;
  }
  const result = await cleanupExpiredShareLinks(100, { sweepOrphans: true });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
