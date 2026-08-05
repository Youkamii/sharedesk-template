import { NextRequest, NextResponse } from "next/server";
import { getAdapter } from "@/lib/storage";
import { errorResponse } from "@/lib/api";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id가 필요합니다" }, { status: 400 });
  }
  try {
    const file = await getAdapter().download(id);
    const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    const headers = new Headers({
      "Content-Type": file.mimeType,
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    if (file.size !== null) headers.set("Content-Length", String(file.size));
    return new Response(file.stream, { headers });
  } catch (e) {
    return errorResponse(e);
  }
}
