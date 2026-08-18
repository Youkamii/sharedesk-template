import { NextRequest, NextResponse } from "next/server";
import { resolveShareLink } from "@/lib/share-links";
import { getAdapter } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 외부 공유 다운로드 — 로그인 없이 링크만으로 파일 하나를 내려받는다.
// 링크 id 자체가 비밀(48자리 난수)이고, 만료·취소된 링크는 발급 기록에
// 없으므로 404로 끝난다. 어떤 경우에도 데스크의 다른 내용은 보이지 않는다.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const link = await resolveShareLink(linkId).catch(() => null);
  if (!link) {
    return NextResponse.json(
      { error: "링크가 만료되었거나 존재하지 않습니다" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  // 인증 없는 경로라 Range도 최소한으로만 통과시킨다 — 형식이 이상하면
  // 전체 응답으로 대신한다.
  const rawRange = req.headers.get("range");
  const range =
    rawRange && rawRange.length <= 100 && /^bytes=[\d,\s-]+$/.test(rawRange)
      ? rawRange
      : undefined;
  try {
    const file = await getAdapter().download(link.fileId, range);
    const asciiName = file.name
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "'");
    const encodedName = encodeURIComponent(file.name).replace(
      /['()*!]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    const headers = new Headers({
      "Content-Type": file.mimeType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    });
    if (file.acceptRanges !== false) headers.set("Accept-Ranges", "bytes");
    const length = file.contentLength ?? file.size;
    if (length !== null) headers.set("Content-Length", String(length));
    if (file.status === 206 && file.contentRange) {
      headers.set("Content-Range", file.contentRange);
    }
    return new Response(file.stream, { status: file.status, headers });
  } catch {
    // 파일이 그새 삭제됐어도 링크의 존재 여부와 같은 응답으로 끝낸다.
    return NextResponse.json(
      { error: "링크가 만료되었거나 존재하지 않습니다" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
