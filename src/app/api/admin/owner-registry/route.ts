import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import {
  getOwnerRegistryStatus,
  recordOwnerRegistryObservation,
} from "@/lib/owner-registry";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  return NextResponse.json(getOwnerRegistryStatus(req.nextUrl.origin), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  const result = await recordOwnerRegistryObservation(
    req.nextUrl.origin,
    auth.session.email,
  );
  return NextResponse.json(result, {
    status: result.ok ? 200 : result.reason === "disabled" ? 409 : 502,
    headers: { "Cache-Control": "private, no-store" },
  });
}
