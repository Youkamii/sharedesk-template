import { NextRequest, NextResponse } from "next/server";
import { requireUploadRights } from "@/lib/api";
import {
  deskTransferEntryUrls,
  parseDeskTransferLink,
} from "@/lib/desk-transfer";
import { readManifest } from "@/lib/desk-transfer-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 보내는 데스크의 목록을 대신 읽어 준다. 브라우저가 다른 데스크 주소로 직접
 * 요청하면 CORS에 막히므로 받는 데스크 서버가 중간에 선다.
 *
 * 가져오기 직전 단계라 업로드 권한을 그대로 요구한다 — 받을 수 없는 사람이
 * 남의 데스크 목록만 들여다보는 경로를 열지 않는다.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;

  let body: { url?: unknown; entryId?: unknown };
  try {
    body = (await req.json()) as { url?: unknown; entryId?: unknown };
  } catch {
    return NextResponse.json(
      { error: "요청 본문을 읽지 못했습니다" },
      { status: 400 },
    );
  }

  const source = parseDeskTransferLink(body.url);
  if (!source) {
    return NextResponse.json(
      { error: "다른 데스크의 공개 링크 주소가 아닙니다" },
      { status: 400 },
    );
  }

  let manifestUrl = source.manifestUrl;
  if (body.entryId !== undefined && body.entryId !== null) {
    if (typeof body.entryId !== "string") {
      return NextResponse.json(
        { error: "항목 id가 올바르지 않습니다" },
        { status: 400 },
      );
    }
    const urls = deskTransferEntryUrls(source, body.entryId);
    if (!urls) {
      return NextResponse.json(
        { error: "항목 id가 올바르지 않습니다" },
        { status: 400 },
      );
    }
    manifestUrl = urls.manifestUrl;
  }

  const manifest = await readManifest(manifestUrl);
  if (!manifest) {
    return NextResponse.json(
      { error: "보내는 데스크에서 목록을 가져오지 못했습니다" },
      { status: 502 },
    );
  }

  return NextResponse.json(manifest, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
