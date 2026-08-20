import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import {
  addStar,
  checkOwnerStarred,
  resolveStarToken,
  starPageUrl,
} from "@/lib/github-star";
import { parseLocale, type Locale } from "@/lib/i18n";
import {
  hasAutoUpdateWorkflow,
  resolveUpdateRepository,
} from "@/lib/update-status";
import {
  getDeskSettings,
  parseOptionalByteLimit,
  parseTimezone,
  setDeskSettings,
} from "@/lib/users";

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
    maxUploadBytes?: number | null;
    deskStorageLimitBytes?: number | null;
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

  for (const key of ["maxUploadBytes", "deskStorageLimitBytes"] as const) {
    if (!(key in body)) continue;
    const parsed = parseOptionalByteLimit(
      (body as Record<string, unknown>)[key],
    );
    if (parsed === undefined) {
      return NextResponse.json(
        { error: "용량 제한 값을 확인해 주세요" },
        { status: 400 },
      );
    }
    patch[key] = parsed;
  }

  if (
    patch.locale === undefined &&
    patch.allowMemberLocale === undefined &&
    patch.autoUpdate === undefined &&
    patch.maxUploadBytes === undefined &&
    patch.deskStorageLimitBytes === undefined
  ) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  if (
    patch.maxUploadBytes !== undefined ||
    patch.deskStorageLimitBytes !== undefined
  ) {
    const current = await getDeskSettings({ fresh: true });
    const nextMax =
      patch.maxUploadBytes !== undefined
        ? patch.maxUploadBytes
        : current.maxUploadBytes;
    const nextDesk =
      patch.deskStorageLimitBytes !== undefined
        ? patch.deskStorageLimitBytes
        : current.deskStorageLimitBytes;
    if (nextMax !== null && nextDesk !== null && nextMax > nextDesk) {
      return NextResponse.json(
        { error: "한 번 업로드 제한은 데스크 전체 제한보다 클 수 없습니다" },
        { status: 400 },
      );
    }
  }

  if (patch.autoUpdate === true) {
    // 예전 설치에는 자동 업데이트 워크플로 파일이 없다. 그 상태로 켜면
    // 버튼만 사라지고 아무 일도 안 일어나므로, 확인 가능한 환경에서는
    // 파일이 생길 때까지 켜기를 거부한다(문서의 1회 추가 절차 안내).
    const workflowPresent = await hasAutoUpdateWorkflow();
    if (workflowPresent === false) {
      return NextResponse.json(
        {
          error:
            "이 저장소에는 자동 업데이트 워크플로가 아직 없습니다. 업데이트 안내 문서의 '자동 업데이트' 절을 따라 파일을 한 번 추가한 뒤 다시 켜 주세요.",
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    // 자동 업데이트는 별이 실제로 박혀 있어야만 켜진다. 설치 저장소
    // 주인이 템플릿 저장소에 별을 눌렀는지 공개 스타 목록으로 검증한다
    // — 토큰 권한과 무관하게 확인되는 진짜 게이트다. 토큰이 별을 남길
    // 수 있으면 먼저 남겨 두고(최선 노력) 검증한다.
    const repository = resolveUpdateRepository();
    if (repository.configured) {
      const owner = repository.repository.split("/")[0];
      const token = resolveStarToken();
      let verified = await checkOwnerStarred(owner, { token });
      if (verified.ok && !verified.starred) {
        const added = await addStar({ token });
        console.info("[admin]", {
          event: added.ok ? "star-added" : "star-skipped",
          repository: starPageUrl(),
          actorUserId: auth.session.userId,
        });
        if (added.ok) verified = await checkOwnerStarred(owner, { token });
      }
      if (!(verified.ok && verified.starred)) {
        return NextResponse.json(
          {
            error: verified.ok
              ? "저장소에 아직 별이 없습니다. GitHub에서 별을 누른 뒤 다시 시도해 주세요."
              : verified.error,
            starRequired: true,
            starPageUrl: starPageUrl(),
          },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
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
