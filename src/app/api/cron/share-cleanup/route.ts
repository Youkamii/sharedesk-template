import { NextRequest, NextResponse } from "next/server";
import { runWithAdmin } from "@/lib/api";
import { runWithSpace } from "@/lib/space-context";
import { cleanupExpiredShareLinks } from "@/lib/share-links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function cleanup() {
  const result = await cleanupExpiredShareLinks(100, { sweepOrphans: true });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  const scheduled =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  if (scheduled) {
    // 예약 실행은 세션이 없다. 기본 데스크 문맥을 명시한다 — 스페이스의
    // 만료 링크는 아직 이 경로가 청소하지 못한다(알려진 한계, 인수인계 문서).
    return runWithSpace(null, () => cleanup());
  }
  return runWithAdmin({ fresh: true }, () => cleanup());
}
