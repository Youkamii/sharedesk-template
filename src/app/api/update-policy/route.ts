import { NextResponse } from "next/server";
import { getDeskSettingsOrDefault } from "@/lib/users";
import packageJson from "../../../../package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 자동 업데이트 예약 워크플로가 키 없이 읽어 가는 공개 정책.
// 워크플로는 GitHub 쪽 자격만 갖고 있어 여기서 로그인할 수 없으므로
// 인증을 걸지 않는다. 대신 데스크 내용은 일절 담지 않고, 자동 업데이트
// 여부·기준 시간대·현재 버전만 내려 준다.
export async function GET() {
  const settings = await getDeskSettingsOrDefault();
  return NextResponse.json(
    {
      autoUpdate: settings.autoUpdate,
      timezone: settings.autoUpdate ? settings.autoUpdateTimezone : null,
      currentVersion: packageJson.version,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
