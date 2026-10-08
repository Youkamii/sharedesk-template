import { NextRequest, NextResponse } from "next/server";
import { runWithSession } from "@/lib/api";
import { createUserSession } from "@/lib/auth";
import { runWithSpace } from "@/lib/space-context";
import { INVISIBLE_CHARS } from "@/lib/storage/types";
import {
  CLI_SESSION_LABEL_PREFIX,
  MAX_CLI_SESSIONS,
  MAX_DEVICE_LABEL_LENGTH,
  issueUserSession,
} from "@/lib/users";

// CLI 토큰 발급(#34). 로그인한 멤버가 자기 명의의 기기 세션을 하나 더 만들고
// 그 서명 토큰을 한 번만 받는다 — 서버는 토큰을 저장하지 않는다(세션 id만
// 명단에 남는다). CLI는 이 토큰을 브라우저와 똑같이 세션 쿠키로 보내므로
// 인증 경로가 하나뿐이고, 관리자의 기기 세션 끊기가 CLI에도 그대로 미친다.
// 명단의 진실 원천은 기본 데스크라 스페이스 화면에서 불러도 기본 문맥에 쓴다.

const DEFAULT_LABEL = "에이전트";

function parseLabel(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return DEFAULT_LABEL;
  if (typeof value !== "string") return null;
  // 파일 이름과 같은 규칙으로 보이지 않는 문자(bidi·zero-width)까지 걷어 낸다 —
  // 관리자 기기 세션 목록에서 "CLI · " 접두를 가리는 꾸밈을 막는다.
  const label = value
    .replace(new RegExp(`[${INVISIBLE_CHARS}]+`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!label || label.length > MAX_DEVICE_LABEL_LENGTH - CLI_SESSION_LABEL_PREFIX.length) {
    return null;
  }
  return label;
}

export async function POST(req: NextRequest) {
  return runWithSession({ fresh: true }, async ({ session }) => {
    if (session.isGuest) {
      return NextResponse.json(
        { error: "손님 세션은 CLI 토큰을 만들 수 없습니다" },
        { status: 403 },
      );
    }
    const body = await req.json().catch(() => null);
    const label = parseLabel(body?.label);
    if (label === null) {
      return NextResponse.json(
        { error: "라벨은 1~74자이고 제어 문자를 쓸 수 없습니다" },
        { status: 400 },
      );
    }
    const issued = await runWithSpace(null, () =>
      issueUserSession(session.userId, CLI_SESSION_LABEL_PREFIX + label),
    );
    if (!issued) {
      return NextResponse.json(
        { error: "승인된 멤버만 CLI 토큰을 만들 수 있습니다" },
        { status: 403 },
      );
    }
    if ("error" in issued) {
      return NextResponse.json(
        // 화면이 t(error)로 그대로 번역하므로 자리표시자 대신 숫자를 박는다.
        { error: `CLI 토큰은 ${MAX_CLI_SESSIONS}개까지 만들 수 있습니다. 관리자에게 오래된 토큰을 끊어 달라고 하세요` },
        { status: 409 },
      );
    }
    const token = await createUserSession(
      issued.user.id,
      issued.user.sessionVersion,
      issued.session.id,
    );
    return NextResponse.json(
      {
        token,
        sessionId: issued.session.id,
        deviceLabel: issued.session.deviceLabel,
        createdAt: issued.session.createdAt,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  });
}
