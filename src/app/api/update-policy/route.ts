import { NextResponse } from "next/server";
import { getDeskSettingsOrDefault } from "@/lib/users";
import packageJson from "../../../../package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 자동 업데이트 예약 워크플로가 키 없이 읽어 가는 공개 정책.
// 워크플로는 GitHub 쪽 자격만 갖고 있어 여기서 로그인할 수 없으므로
// 인증을 걸지 않는다. 대신 데스크 내용은 일절 담지 않고, 시간대도
// 노출하지 않는다 — "지금이 그 시간대의 자정 창인가"만 서버가 계산해
// 내려 준다. 창을 00~01시로 넓게 잡아 예약 실행이 늦게 떠도(수십 분
// 지연이 흔하다) 그날 업데이트를 놓치지 않는다. 두 번 걸려도 두 번째
// 실행은 바뀐 것이 없어 그대로 끝난다.
export async function GET() {
  const settings = await getDeskSettingsOrDefault();
  let midnight = false;
  if (settings.autoUpdate && settings.autoUpdateTimezone) {
    try {
      const hour = new Intl.DateTimeFormat("en-GB", {
        timeZone: settings.autoUpdateTimezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date());
      midnight = hour === "00" || hour === "01";
    } catch {
      midnight = false;
    }
  }
  return NextResponse.json(
    {
      autoUpdate: settings.autoUpdate,
      midnight,
      currentVersion: packageJson.version,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
