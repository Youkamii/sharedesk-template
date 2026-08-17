import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import {
  dispatchUpdateWorkflow,
  fetchLatestUpdateRun,
  getUpdateStatus,
} from "@/lib/update-status";
import packageJson from "../../../../../package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

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
}

export async function POST() {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

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
}
