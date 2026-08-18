import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import {
  addStar,
  checkStarred,
  resolveStarToken,
  starPageUrl,
} from "@/lib/github-star";
import { parseLocale, type Locale } from "@/lib/i18n";
import { getDeskSettings, parseTimezone, setDeskSettings } from "@/lib/users";

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
  const patch: {
    locale?: Locale;
    allowMemberLocale?: boolean;
    autoUpdate?: boolean;
    autoUpdateTimezone?: string | null;
  } = {};
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

  if ("autoUpdate" in body) {
    const auto = (body as { autoUpdate?: unknown }).autoUpdate;
    if (typeof auto !== "boolean") {
      return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    }
    patch.autoUpdate = auto;
    if (auto) {
      // 켤 때는 켠 관리자 브라우저의 시간대를 함께 받아 자정 기준으로 삼는다.
      const timezone = parseTimezone(
        (body as { autoUpdateTimezone?: unknown }).autoUpdateTimezone,
      );
      if (!timezone) {
        return NextResponse.json(
          { error: "시간대 값을 확인해 주세요" },
          { status: 400 },
        );
      }
      patch.autoUpdateTimezone = timezone;
    }
  }

  if (
    patch.locale === undefined &&
    patch.allowMemberLocale === undefined &&
    patch.autoUpdate === undefined
  ) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  // 자동 업데이트도 수동 업데이트와 같은 별 게이트를 지난다: 아직 별을
  // 안 눌렀으면 동의를 받아 별을 남긴 뒤에 켠다. 별 남기기 실패나 확인
  // 불가(토큰 없음 등)는 켜는 것을 막지 않는다.
  if (patch.autoUpdate === true) {
    const agreedToStar =
      (body as { star?: unknown } | null)?.star === true;
    const token = resolveStarToken();
    const starCheck = await checkStarred({ token });
    if (starCheck.ok && !starCheck.starred) {
      if (!agreedToStar) {
        return NextResponse.json(
          {
            error:
              "자동 업데이트를 켜려면 GitHub에서 ShareDesk 저장소에 별을 눌러 주세요.",
            starRequired: true,
            starPageUrl: starPageUrl(),
          },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
      const starred = await addStar({ token });
      console.info("[admin]", {
        event: starred.ok ? "star-added" : "star-skipped",
        repository: starPageUrl(),
        actorUserId: auth.session.userId,
        ...(starred.ok ? {} : { status: starred.status }),
      });
    }
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
