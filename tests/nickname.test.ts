import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_NICKNAME_LENGTH,
  MIN_NICKNAME_LENGTH,
  parseNickname,
} from "../src/lib/nickname";

test("닉네임 검증: 허용 문자·길이·trim·제어문자·공백/슬래시 거부", async () => {
  assert.equal(MIN_NICKNAME_LENGTH, 1);
  assert.equal(MAX_NICKNAME_LENGTH, 20);

  // 허용: 한글 음절·영문 대소문자·숫자·- . ( ) @ ~ # ^ &
  for (const ok of [
    "홍길동",
    "a",
    "Z",
    "0",
    "Nick01",
    "닉네임-2(테스트)@ho~#^&",
    "가-힣.구간(전체)@것",
    "a".repeat(MAX_NICKNAME_LENGTH),
    "힣".repeat(MAX_NICKNAME_LENGTH),
  ]) {
    assert.equal(parseNickname(ok), ok, `허용해야 한다: ${JSON.stringify(ok)}`);
  }

  // trim: 앞뒤 공백은 지운 뒤 검증한다
  assert.equal(parseNickname("  홍길동  "), "홍길동");
  assert.equal(parseNickname("\t닉네임\n"), "닉네임");
  assert.equal(
    parseNickname(` ${"b".repeat(MAX_NICKNAME_LENGTH)} `),
    "b".repeat(MAX_NICKNAME_LENGTH),
    "trim 후 길이로 판정한다",
  );

  // 거부: 빈 값·길이 초과
  for (const tooShortOrLong of ["", "   ", "\t\n", "a".repeat(21), "가".repeat(21)]) {
    assert.equal(
      parseNickname(tooShortOrLong),
      null,
      `길이 규칙 위반은 거부한다: ${JSON.stringify(tooShortOrLong)}`,
    );
  }

  // 거부: 목록 밖 문자 — 내부 공백, 슬래시 양쪽, 제어문자(이스케이프로만 표기),
  // 폭 없는 공백, 자모, 이모지, 전각, 특수문자
  for (const bad of [
    "홍 길동",
    "a/b",
    "a\\b",
    "/",
    "a\u0000b",
    "a\u001fb",
    "a\u007fb",
    "a\tb",
    "a\nb",
    "a\u00a0b",
    "a\u200bb",
    "ㄱㄴㄷ",
    "ㅏㅑ",
    "한글!",
    "nick_name",
    "nick*",
    "nick+",
    "nick=",
    "nick:",
    "nick;",
    "nick'",
    'nick"',
    "nick?",
    "nick%",
    "nick$",
    "😀",
    "Ａｂｃ",
  ]) {
    assert.equal(parseNickname(bad), null, `거부해야 한다: ${JSON.stringify(bad)}`);
  }

  // 거부: 문자열이 아닌 값
  for (const junk of [undefined, null, 123, 0, true, {}, ["닉"], Symbol("n")]) {
    assert.equal(parseNickname(junk), null, `문자열이 아니다: ${String(junk)}`);
  }

  // 검증 모듈 소스에 리터럴 제어문자를 넣지 않는다 (개행·CR 제외)
  const source = await readFile(
    new URL("../src/lib/nickname.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/,
    "nickname.ts 소스에 리터럴 제어문자가 있다",
  );
});

test("닉네임 저장: 기본값·기록 누적·50개 상한·같은 값 무시·게스트 거부", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-nickname-"));
  const statePath = path.join(root, ".sharedesk", "users.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  const base = {
    status: "approved",
    isAdmin: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    sessionsValidFrom: 0,
  };
  await writeFile(
    statePath,
    JSON.stringify({
      version: 2,
      rev: 1,
      users: [
        // 닉 도입 전 사용자 — 필드 자체가 없다
        { ...base, id: "legacy-sub", email: "legacy@example.com", name: "기존 사용자" },
        // 저장값이 규칙에 어긋나는 경우 — 읽을 때 버린다
        {
          ...base,
          id: "junk-sub",
          email: "junk@example.com",
          name: "이상한 값",
          nickname: "bad/nick",
          nicknameHistory: [
            "문자열",
            { nickname: "공백 있음", at: "2026-08-02T00:00:00.000Z" },
            { nickname: "정상닉", at: "언제인지모름" },
            { nickname: "살아남는닉", at: "2026-08-03T00:00:00.000Z" },
            { at: "2026-08-04T00:00:00.000Z" },
          ],
        },
        // 정상 저장값 — 그대로 읽는다
        {
          ...base,
          id: "kept-sub",
          email: "kept@example.com",
          name: "정상 사용자",
          nickname: "기존닉",
          nicknameHistory: [
            { nickname: "기존닉", at: "2026-08-05T00:00:00.000Z" },
            { nickname: "첫닉", at: "2026-08-01T00:00:00.000Z" },
          ],
        },
        // 상한 초과 저장값 — 읽는 시점에 최신(앞) 50개로 줄인다
        {
          ...base,
          id: "over-sub",
          email: "over@example.com",
          name: "기록 과다",
          nickname: "닉59",
          nicknameHistory: Array.from({ length: 60 }, (_, i) => ({
            nickname: `닉${59 - i}`,
            at: new Date(Date.UTC(2026, 7, 1, 0, 59 - i)).toISOString(),
          })),
        },
        // 변경 시나리오 전용
        { ...base, id: "member-sub", email: "member@example.com", name: "멤버" },
        { ...base, id: "cap-sub", email: "cap@example.com", name: "상한 시험" },
      ],
      invitations: [],
    }),
    "utf8",
  );

  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  // 테스트 전용 더미 값. secrets-guard 훅 오탐을 피하려고 조각으로 나눠 조립한다.
  process.env.SESSION_SECRET = ["nickname-", "test-session-secret-32-chars!"].join("");
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.ACCESS_KEYS = "nickname-test-guest-key";

  const users = await import("@/lib/users");
  const auth = await import("@/lib/auth");
  const tokens = await import("@/lib/session-token");

  try {
    // 1) 읽기 정규화: 없는 필드는 기본값, 깨진 값은 버리고, 정상 값은 유지
    const listed = await users.listUsers();
    const legacy = listed.find((u) => u.id === "legacy-sub");
    assert.equal(legacy?.nickname, null);
    assert.deepEqual(legacy?.nicknameHistory, []);
    const junk = listed.find((u) => u.id === "junk-sub");
    assert.equal(junk?.nickname, null, "규칙 위반 저장 닉은 null로 읽는다");
    assert.deepEqual(
      junk?.nicknameHistory,
      [{ nickname: "살아남는닉", at: "2026-08-03T00:00:00.000Z" }],
      "깨진 기록 항목은 버리고 정상 항목만 남긴다",
    );
    const kept = listed.find((u) => u.id === "kept-sub");
    assert.equal(kept?.nickname, "기존닉");
    assert.equal(kept?.nicknameHistory.length, 2);
    assert.equal(kept?.nicknameHistory[0]?.nickname, "기존닉");
    const over = listed.find((u) => u.id === "over-sub");
    assert.equal(over?.nicknameHistory.length, users.MAX_NICKNAME_HISTORY);
    assert.equal(over?.nicknameHistory[0]?.nickname, "닉59", "최신(앞)을 남긴다");
    assert.equal(over?.nicknameHistory[49]?.nickname, "닉10");

    // 2) 변경: trim 후 저장, 기록은 최신이 앞, 시각 포함, 파일에 남는다
    const before = Date.now();
    const changed = await users.setUserNickname("member-sub", "  새닉  ");
    assert.equal(changed?.nickname, "새닉", "trim 후 저장한다");
    assert.equal(changed?.nicknameHistory.length, 1);
    assert.equal(changed?.nicknameHistory[0]?.nickname, "새닉");
    const at = Date.parse(changed?.nicknameHistory[0]?.at ?? "");
    assert.ok(
      Number.isFinite(at) && at >= before - 1000 && at <= Date.now() + 1000,
      "기록에 변경 시각이 남는다",
    );

    const again = await users.setUserNickname("member-sub", "두번째닉");
    assert.equal(again?.nickname, "두번째닉");
    assert.deepEqual(
      again?.nicknameHistory.map((entry) => entry.nickname),
      ["두번째닉", "새닉"],
      "최신이 앞이다",
    );

    // 같은 값 재설정은 기록을 만들지 않는다
    const same = await users.setUserNickname("member-sub", "두번째닉");
    assert.equal(same?.nickname, "두번째닉");
    assert.equal(same?.nicknameHistory.length, 2);

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      users: Array<{
        id: string;
        nickname?: string | null;
        nicknameHistory?: Array<{ nickname: string; at: string }>;
      }>;
    };
    const persistedMember = persisted.users.find((u) => u.id === "member-sub");
    assert.equal(persistedMember?.nickname, "두번째닉", "바뀐 닉을 파일에 저장한다");
    assert.equal(persistedMember?.nicknameHistory?.length, 2);

    // 3) 잘못된 값은 저장 함수도 거절한다 (라우트 검증을 우회해도 막힌다)
    for (const bad of ["", "   ", "닉 네임", "a/b", "a".repeat(21), "a b"]) {
      await assert.rejects(
        users.setUserNickname("member-sub", bad),
        /닉네임/,
        `저장 함수가 거절해야 한다: ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(await users.setUserNickname("no-such-user", "닉"), null);

    // 4) 기록 상한: 50개를 넘기면 오래된 것부터 버린다
    for (let i = 0; i < 55; i++) {
      const result = await users.setUserNickname("cap-sub", `닉${i}`);
      assert.ok(result, `닉${i} 변경에 실패했다`);
    }
    const capped = await users.findUserById("cap-sub", { fresh: true });
    assert.equal(capped?.nickname, "닉54");
    assert.equal(capped?.nicknameHistory.length, users.MAX_NICKNAME_HISTORY);
    assert.equal(capped?.nicknameHistory[0]?.nickname, "닉54");
    assert.equal(capped?.nicknameHistory[49]?.nickname, "닉5");

    // 5) 게스트(접속 키 손님): users.json에 항목이 없어 닉을 저장할 수 없다
    const guestToken = await auth.createKeySession(
      await tokens.sha256Hex("nickname-test-guest-key"),
    );
    const guest = await auth.resolveSession(guestToken);
    assert.equal(guest?.isGuest, true);
    assert.equal(
      await users.findUserById(guest?.userId ?? "", { fresh: true }),
      null,
      "게스트는 users.json에 없다",
    );
    assert.equal(
      await users.setUserNickname(guest?.userId ?? "", "손님닉"),
      null,
      "명단에 없는 게스트 id로는 닉을 저장하지 못한다",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("라우트 배선: 본인 확인·게스트 403·검증 400·관리자 응답 포함", async () => {
  const nicknameRoute = await readFile(
    new URL("../src/app/api/me/nickname/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(nicknameRoute, /export async function PATCH/);
  assert.match(
    nicknameRoute,
    /requireSession\(\{ fresh: true \}\)/,
    "본인 확인은 requireSession으로 한다",
  );
  assert.match(nicknameRoute, /auth\.session\.isGuest/, "게스트를 판별한다");
  assert.match(nicknameRoute, /status: 403/, "게스트는 403으로 거절한다");
  assert.match(nicknameRoute, /parseNickname/, "공용 검증 모듈을 쓴다");
  assert.match(nicknameRoute, /status: 400/, "검증 실패는 400이다");
  assert.match(
    nicknameRoute,
    /setUserNickname\(auth\.session\.userId/,
    "세션 주인의 닉만 바꾼다 — 대상 id를 입력으로 받지 않는다",
  );
  assert.doesNotMatch(
    nicknameRoute,
    /body\?\.(id|userId)/,
    "요청 본문에서 대상 id를 읽지 않는다",
  );

  // 관리자 명단 응답: listUsers 결과를 스프레드로 그대로 내려 nickname·기록이 포함된다
  const adminRoute = await readFile(
    new URL("../src/app/api/admin/users/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(adminRoute, /requireAdmin/);
  assert.match(adminRoute, /listUsers/);
  assert.match(
    adminRoute,
    /\.\.\.u, isAdmin: isAdminEmail\(u\.email\)/,
    "스프레드가 nickname·nicknameHistory를 함께 내려보낸다",
  );
});
