import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { runWithSession } from "@/lib/api";
import { parseNickname } from "@/lib/nickname";
import { runWithSpace } from "@/lib/space-context";
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
      // 닉네임의 진실 원천은 기본 데스크 명단이다(#13) — 스페이스 화면에서
      // 바꿔도 기본 명단에 쓴다. 스페이스 문맥에 쓰면 데스크마다 닉이 갈라져
      // 접속 인원·관리자 화면(기본 명단 기준)과 어긋난다.
      const user = await runWithSpace(null, async () => {
        const updated = await setUserNickname(session.userId, nickname);
        if (updated) {
          // 닉 변경도 활동 로그에 남는다 — 진실 원천과 같은 기본 데스크
          // 활동 파일에 기록한다(닉네임 저장과 같은 문맥).
          recordActivityAfter(session, "nickname", nickname);
        }
        return updated;
      });
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
