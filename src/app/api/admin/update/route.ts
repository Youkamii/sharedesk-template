import { NextRequest, NextResponse } from "next/server";
import { runWithAdmin } from "@/lib/api";
import { passStarGate, starPageUrl } from "@/lib/github-star";
import {
  dispatchUpdateWorkflow,
  fetchLatestUpdateRun,
  getUpdateStatus,
} from "@/lib/update-status";
import packageJson from "../../../../../package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return runWithAdmin({ fresh: true }, async () => {
    if (request.nextUrl.searchParams.get("scope") === "run") {
      const result = await fetchLatestUpdateRun();
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error },
          { status: result.status, headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json(
        { currentVersion: packageJson.version, run: result.run },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const status = await getUpdateStatus();
    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store" },
    });
  });
}

export async function POST(request: NextRequest) {
  return runWithAdmin({ fresh: true }, async ({ session }) => {
    // 업데이트는 원본 저장소에 별을 남기는 데 동의해야 시작한다.
    // 이미 눌러 둔 설치는 그대로 통과하고, 별 남기기 실패는 막지 않는다.
    const body = await request.json().catch(() => null);
    const gate = await passStarGate({
      agreed: (body as { star?: unknown } | null)?.star === true,
      actorUserId: session.userId,
    });
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: "업데이트하려면 GitHub에서 ShareDesk 저장소에 별을 눌러 주세요.",
          starRequired: true,
          starPageUrl: starPageUrl(),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    // 실행이 이미 달리는 중이면 중복 디스패치 대신 그 실행을 알려 준다.
    // 조회가 실패하면 디스패치 쪽이 같은 원인의 정확한 오류를 돌려준다.
    const current = await fetchLatestUpdateRun();
    if (
      current.ok &&
      current.run &&
      (current.run.status === "queued" || current.run.status === "in_progress")
    ) {
      return NextResponse.json(
        { error: "이미 업데이트가 진행 중입니다.", run: current.run },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    const result = await dispatchUpdateWorkflow();
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, workflowUrl: result.workflowUrl },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  });
}
