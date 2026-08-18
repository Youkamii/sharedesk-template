import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import { parseLocale, type Locale } from "@/lib/i18n";
import { getDeskSettings, setDeskSettings } from "@/lib/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  const settings = await getDeskSettings({ fresh: true });
  return NextResponse.json(settings, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const patch: { locale?: Locale; allowMemberLocale?: boolean } = {};
  if ("locale" in body) {
    const locale = parseLocale((body as { locale?: unknown }).locale);
    if (!locale) {
      return NextResponse.json(
        { error: "언어 값을 확인해 주세요" },
        { status: 400 },
      );
    }
    patch.locale = locale;
  }
  if ("allowMemberLocale" in body) {
    const allow = (body as { allowMemberLocale?: unknown }).allowMemberLocale;
    if (typeof allow !== "boolean") {
      return NextResponse.json(
        { error: "잘못된 요청입니다" },
        { status: 400 },
      );
    }
    patch.allowMemberLocale = allow;
  }

  try {
    const settings = await setDeskSettings(patch);
    console.info("[admin]", {
      event: "desk-settings-changed",
      settings,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json(settings, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "처리하지 못했습니다" },
      { status: 400 },
    );
  }
}
