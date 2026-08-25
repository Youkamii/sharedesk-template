import { NextRequest, NextResponse } from "next/server";
import { runWithSession } from "@/lib/api";
import { parseNickname } from "@/lib/nickname";
import { setUserNickname } from "@/lib/users";

// 본인 닉네임 변경. 대상 id를 입력으로 받지 않는다 — 항상 세션 주인의
// 항목만 바꾸므로 타인 닉 변경 경로 자체가 없다.
export async function PATCH(req: NextRequest) {
  return runWithSession({ fresh: true }, async ({ session }) => {
    // 접속 키 손님은 users.json에 항목이 없다 — 닉네임을 저장할 곳이 없다.
    if (session.isGuest) {
      return NextResponse.json(
        { error: "손님 세션은 닉네임을 바꿀 수 없습니다" },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => null);
    const nickname = parseNickname(body?.nickname);
    if (nickname === null) {
      return NextResponse.json(
        {
          error:
            "닉네임은 1~20자이고 한글·영문·숫자와 - . ( ) @ ~ # ^ & 만 쓸 수 있습니다",
        },
        { status: 400 },
      );
    }

    try {
      const user = await setUserNickname(session.userId, nickname);
      if (!user) {
        return NextResponse.json({ error: "없는 사용자입니다" }, { status: 404 });
      }
      return NextResponse.json({
        user: {
          id: user.id,
          nickname: user.nickname,
          nicknameHistory: user.nicknameHistory,
        },
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "처리하지 못했습니다" },
        { status: 400 },
      );
    }
  });
}
