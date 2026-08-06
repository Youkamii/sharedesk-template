import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { errorResponse, requireSession } from "@/lib/api";

export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id가 필요합니다" }, { status: 400 });
  }
  try {
    const file = await getAdapter().download(id);
    // 따옴표·백슬래시는 quoted-string 파싱을 깨뜨리므로 ASCII 폴백에서 제거한다.
    const asciiName = file.name
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "'");
    // RFC 5987 attr-char에 없는 문자까지 인코딩 (encodeURIComponent가 남기는 ' * ( ) !).
    const encodedName = encodeURIComponent(file.name).replace(
      /['()*!]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    const headers = new Headers({
      "Content-Type": file.mimeType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    });
    if (file.size !== null) headers.set("Content-Length", String(file.size));
    return new Response(file.stream, { headers });
  } catch (e) {
    return errorResponse(e);
  }
}
