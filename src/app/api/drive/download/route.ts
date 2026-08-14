import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { errorResponse, requireSession } from "@/lib/api";
import { inlineContentType } from "@/lib/preview";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const wantsInline =
    req.nextUrl.searchParams.get("disposition") === "inline";
  const auth = await requireSession({ fresh: wantsInline });
  if ("response" in auth) return auth.response;
  if (!id) {
    return NextResponse.json({ error: "id가 필요합니다" }, { status: 400 });
  }
  const range = req.headers.get("range") ?? undefined;
  try {
    const adapter = getAdapter();
    const file = wantsInline
      ? await adapter.preview(id, range)
      : await adapter.download(id, range);
    // 따옴표·백슬래시는 quoted-string 파싱을 깨뜨리므로 ASCII 폴백에서 제거한다.
    const asciiName = file.name
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "'");
    // RFC 5987 attr-char에 없는 문자까지 인코딩 (encodeURIComponent가 남기는 ' * ( ) !).
    const encodedName = encodeURIComponent(file.name).replace(
      /['()*!]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    const inlineType = wantsInline
      ? inlineContentType(file.mimeType, file.name)
      : null;
    const headers = new Headers({
      "Content-Type": inlineType ?? file.mimeType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${inlineType ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    });
    if (file.acceptRanges !== false) headers.set("Accept-Ranges", "bytes");
    const length = file.contentLength ?? file.size;
    if (length !== null) headers.set("Content-Length", String(length));
    if (file.status === 206 && file.contentRange) {
      headers.set("Content-Range", file.contentRange);
    }
    return new Response(file.stream, { status: file.status, headers });
  } catch (e) {
    return errorResponse(e);
  }
}
