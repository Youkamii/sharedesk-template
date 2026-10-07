import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendActivity,
  GUEST_UPLOAD_MERGE_MS,
  type ActivityEntry,
} from "../src/lib/activity";
import { translate } from "../src/lib/i18n";
import {
  GUEST_NAME_HEADER,
  guestDisplayName,
  MAX_GUEST_NAME_LENGTH,
  parseGuestName,
  parseGuestNameHeader,
} from "../src/lib/nickname";
import { assertValidName } from "../src/lib/storage/types";

// 공개 폴더 외부 업로드의 "보내는 사람" 이름(#17 B-4): 정제·검증 순수 함수,
// 저장소 이름 검증과 공유하는 보이지 않는 문자 집합, 손님 업로드 활동 묶기,
// 실제 업로드 핸들러(헤더로 받은 이름 → 내력·활동), 화면 배선.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("보내는 사람 이름: 보이지 않는 문자를 걷고 공백을 접는다 (#17 B-4)", () => {
  // 보내지 않았거나 비었으면 이름 없음(null) — 업로드는 그대로 받는다.
  assert.equal(parseGuestName(null), null);
  assert.equal(parseGuestName(undefined), null);
  assert.equal(parseGuestName(""), null);
  assert.equal(parseGuestName("   "), null);
  // 문자열이 아니면 받을 수 없는 값.
  assert.equal(parseGuestName(42), undefined);
  assert.equal(parseGuestName(["홍길동"]), undefined);

  // 띄어쓰기·괄호는 닉네임과 달리 받는다. 공백은 한 칸으로.
  assert.equal(parseGuestName("  홍길동   (디자인팀)  "), "홍길동 (디자인팀)");
  // 보이지 않는 문자 제거가 먼저 — 줄바꿈·탭도 제어문자라 지워진다.
  assert.equal(parseGuestName("홍길동\n\t디자인팀"), "홍길동디자인팀");
  // 제어문자(C0·C1), 방향 제어, zero-width·BOM.
  assert.equal(parseGuestName("홍\u0000길\u0007동\u0085"), "홍길동");
  assert.equal(parseGuestName("kim‮gpj.exe"), "kimgpj.exe");
  assert.equal(parseGuestName("⁦이름⁩‏؜"), "이름");
  assert.equal(parseGuestName("a ​ b﻿"), "a b");
  // 보강한 집합: 소프트 하이픈, 결합 자리채움, 몽골 구분자, 한글 채움 문자,
  // 이형 선택자, 행간 주석, 태그 문자, word joiner 계열.
  for (const hidden of [
    "­",
    "͏",
    "᠎",
    "ᅟ",
    "ᅠ",
    "ㅤ",
    "ﾠ",
    "︀",
    "️",
    "￹",
    "￻",
    "\u{e0000}",
    "\u{e0041}",
    "\u{e007f}",
    "⁠",
    "⁥",
  ]) {
    assert.equal(parseGuestName(`김${hidden}철수`), "김철수", JSON.stringify(hidden));
    assert.equal(parseGuestName(hidden.repeat(3)), null, `${JSON.stringify(hidden)}만 → 이름 없음`);
  }
  // 정제하고 나니 결합 문자(와 공백)만 남으면 이름 없음.
  assert.equal(parseGuestName("́̂"), null);
  assert.equal(parseGuestName(" ́ ㅤ ̂ "), null);
  assert.equal(parseGuestName("é"), "é", "글자에 붙은 결합 문자는 그대로");

  // 길이는 정제한 뒤 센다 — 상한은 받고, 하나 넘으면 거부.
  const max = "가".repeat(MAX_GUEST_NAME_LENGTH);
  assert.equal(parseGuestName(max), max);
  assert.equal(parseGuestName(`${max}가`), undefined);
  assert.equal(parseGuestName(`${max}‮​ㅤ`), max);
});

test("보내는 사람 헤더: percent-encoding을 풀고, 못 풀거나 너무 길면 거부 (#17 B-4)", () => {
  assert.equal(GUEST_NAME_HEADER, "x-sharedesk-sender");
  assert.equal(parseGuestNameHeader(null), null);
  assert.equal(parseGuestNameHeader(""), null);
  assert.equal(
    parseGuestNameHeader(encodeURIComponent("홍길동 (디자인팀)")),
    "홍길동 (디자인팀)",
  );
  assert.equal(parseGuestNameHeader(encodeURIComponent("a‮b")), "ab");
  assert.equal(parseGuestNameHeader("%E0%A4%A"), undefined, "깨진 인코딩");
  assert.equal(parseGuestNameHeader("%".repeat(3)), undefined);
  assert.equal(parseGuestNameHeader("a".repeat(1025)), undefined);
  assert.equal(
    parseGuestNameHeader(encodeURIComponent("가".repeat(MAX_GUEST_NAME_LENGTH + 1))),
    undefined,
  );
});

test("저장소 이름 검증은 그대로다 — 공유 조각(INVISIBLE_CHARS)으로 바꿔도 같은 문자만 막는다", () => {
  // 바꾸기 전 정규식(원문 그대로). 모든 BMP 문자와 태그 문자에서 판정이 같아야 한다.
  const before = new RegExp(
    "[/\\\\\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  );
  const rejects = (character: string) => {
    try {
      assertValidName(`a${character}b`);
      return false;
    } catch {
      return true;
    }
  };
  const codePoints = [
    ...Array.from({ length: 0x10000 }, (_, index) => index),
    ...Array.from({ length: 0x80 }, (_, index) => 0xe0000 + index),
  ];
  const differences = codePoints.filter((codePoint) => {
    const character = String.fromCodePoint(codePoint);
    return rejects(character) !== before.test(character);
  });
  assert.deepEqual(differences, []);
  // 방문자 이름에만 더한 문자는 파일 이름에서 여전히 통과한다.
  for (const extra of ["­", "ㅤ", "᠎", "️", "\u0085", "\u{e0041}"]) {
    assert.equal(rejects(extra), false, JSON.stringify(extra));
  }
});

test("손님 표시: 이름이 있으면 '손님 · 이름', 없으면 '손님' (#17 B-4)", () => {
  const ko = (text: string, vars?: Record<string, string | number>) =>
    translate("ko", text, vars);
  const en = (text: string, vars?: Record<string, string | number>) =>
    translate("en", text, vars);
  assert.equal(guestDisplayName("홍길동", ko), "손님 · 홍길동");
  assert.equal(guestDisplayName(null, ko), "손님");
  assert.equal(guestDisplayName("", ko), "손님");
  assert.equal(guestDisplayName("Kim", en), "Guest · Kim");
  // 값 안의 $ 패턴을 치환 패턴으로 해석하지 않는다.
  assert.equal(guestDisplayName("$`$'", ko), "손님 · $`$'");
});

test("활동 묶기: 같은 공개 폴더에 60초 안에 이어 올라온 손님 업로드는 한 줄 (#17 B-4)", () => {
  const at = (seconds: number) =>
    new Date(Date.parse("2026-10-07T00:00:00.000Z") + seconds * 1_000).toISOString();
  const guest = (seconds: number, name: string, actorName = "홍길동", group = "public:a") =>
    ({ at: at(seconds), actorName, action: "upload", name, guest: true, group }) as ActivityEntry;

  let entries: ActivityEntry[] = [];
  entries = appendActivity(entries, guest(0, "1.txt"));
  entries = appendActivity(entries, guest(30, "2.txt"));
  entries = appendActivity(entries, guest(80, "3.txt"));
  assert.equal(entries.length, 1, "앞 줄 마지막 시각에서 60초 안이면 계속 합친다");
  assert.deepEqual(
    { name: entries[0].name, count: entries[0].count, at: entries[0].at, actorName: entries[0].actorName },
    { name: "3.txt", count: 3, at: at(80), actorName: "홍길동" },
  );

  // 이름이 섞이면 누구 것인지 흐려지지 않게 이름을 비운다("손님").
  entries = appendActivity(entries, guest(90, "4.txt", "김철수"));
  assert.equal(entries[0].actorName, "");
  assert.equal(entries[0].count, 4);

  // 창을 넘거나, 다른 공개 폴더이거나, 사이에 다른 활동이 끼면 새 줄.
  entries = appendActivity(entries, guest(90 + GUEST_UPLOAD_MERGE_MS / 1_000 + 1, "5.txt"));
  assert.equal(entries.length, 2);
  entries = appendActivity(entries, guest(160, "6.txt", "홍길동", "public:b"));
  assert.equal(entries.length, 3);
  entries = appendActivity(entries, {
    at: at(161),
    actorName: "멤버",
    action: "mkdir",
    name: "폴더",
  });
  entries = appendActivity(entries, guest(162, "7.txt", "홍길동", "public:b"));
  assert.equal(entries.length, 5);
  assert.equal(entries[0].count, undefined);

  // 멤버 업로드는 묶지 않는다.
  const member = { at: at(200), actorName: "멤버", action: "upload", name: "m.txt" } as ActivityEntry;
  assert.equal(appendActivity(appendActivity([], member), { ...member, at: at(201) }).length, 2);
});

async function withLocalStorage(run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-public-sender-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    await run();
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

// 기록은 응답 뒤(after) 최선 노력이라, 핸들러를 직접 부르면 기다려 줘야 한다.
async function eventually<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`기다렸지만 기록이 없다 — ${label}`);
}

test("API: 헤더로 받은 이름을 손님 표시와 함께 내력·활동에 남기고, 이어 올린 것은 활동 한 줄로 (#17 B-4)", async () => {
  await withLocalStorage(async () => {
    const [
      { getAdapter },
      { ROOT_ID },
      publicFolders,
      audit,
      activity,
      space,
      { NextRequest },
      route,
    ] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/public-folders"),
      import("../src/lib/entry-audit"),
      import("../src/lib/activity"),
      import("../src/lib/space-store"),
      import("next/server"),
      import("../src/app/api/public-folder/[token]/upload/route"),
    ]);
    await space.runWithSpace(null, async () => {
      const adapter = getAdapter();
      const folder = await adapter.createFolder(ROOT_ID, "받는곳");
      const registered = await publicFolders.addPublicFolder({
        folderId: folder.id,
        folderIdentity: folder.layoutKey,
        name: "받는곳",
        createdByUserId: "u-admin",
      });
      const upload = (name: string, body: string, header?: string, query = "") => {
        const bytes = new TextEncoder().encode(body);
        return route.POST(
          new NextRequest(
            `http://localhost/api/public-folder/${registered.id}/upload?${new URLSearchParams({ name })}${query}`,
            {
              method: "POST",
              body: bytes,
              headers: {
                "content-type": "text/plain",
                "content-length": String(bytes.byteLength),
                ...(header === undefined ? {} : { [GUEST_NAME_HEADER]: header }),
              },
            },
          ),
          { params: Promise.resolve({ token: registered.id }) },
        );
      };
      const entryNamed = async (name: string) =>
        (await adapter.list(folder.id)).find((entry) => entry.name === name);

      // 헤더(percent-encoding)로 온 이름은 정제해서 손님 표시와 함께 남는다.
      const named = await upload(
        "a.txt",
        "from guest",
        encodeURIComponent("  홍길동‮ (디자인팀)ㅤ "),
      );
      assert.equal(named.status, 201);
      const a = await entryNamed("a.txt");
      assert.ok(a);
      const aAudit = await eventually(async () => await audit.getEntryAudit(a.layoutKey), "a.txt 내력");
      assert.equal(aAudit.uploadedBy, "홍길동 (디자인팀)");
      assert.equal(aAudit.uploadedByGuest, true);
      const first = await eventually(
        async () => (await activity.listActivity()).find((entry) => entry.name === "a.txt"),
        "a.txt 활동",
      );
      assert.deepEqual(
        { actorName: first.actorName, action: first.action, guest: first.guest, count: first.count },
        { actorName: "홍길동 (디자인팀)", action: "upload", guest: true, count: undefined },
      );

      // URL 쿼리의 sender는 더 이상 읽지 않는다(접근 로그에 실명이 남지 않게).
      const viaQuery = await upload("b.txt", "query", undefined, "&sender=%EC%BF%BC%EB%A6%AC");
      assert.equal(viaQuery.status, 201);
      const b = await entryNamed("b.txt");
      assert.ok(b);
      const bAudit = await eventually(async () => await audit.getEntryAudit(b.layoutKey), "b.txt 내력");
      assert.equal(bAudit.uploadedBy, undefined, "쿼리 이름은 무시");
      assert.equal(bAudit.uploadedByGuest, true);

      // 같은 폴더에 이어 올린 손님 업로드는 활동 한 줄로 합쳐진다(파일별 내력은 따로).
      const merged = await eventually(
        async () => {
          const entries = await activity.listActivity();
          return entries.length === 1 && entries[0].count === 2 ? entries[0] : null;
        },
        "활동 한 줄로 합침",
      );
      assert.equal(merged.name, "b.txt");
      assert.equal(merged.actorName, "", "이름이 다르면 손님으로만");

      // 41자 이름·깨진 인코딩은 400이고 파일도 만들지 않는다(예약 전에 거른다).
      for (const [file, header] of [
        ["c.txt", encodeURIComponent("가".repeat(MAX_GUEST_NAME_LENGTH + 1))],
        ["d.txt", "%E0%A4%A"],
      ] as const) {
        const rejected = await upload(file, "rejected", header);
        assert.equal(rejected.status, 400);
        assert.equal(
          (await rejected.json()).error,
          `보내는 사람 이름은 ${MAX_GUEST_NAME_LENGTH}자까지 쓸 수 있습니다`,
        );
        assert.equal(await entryNamed(file), undefined);
      }

      // 멤버가 같은 자리에 다시 올리면 손님 표시가 지워진다.
      await audit.recordEntryUpload(a.layoutKey, "멤버");
      const memberAudit = await audit.getEntryAudit(a.layoutKey);
      assert.equal(memberAudit?.uploadedBy, "멤버");
      assert.equal(memberAudit?.uploadedByGuest, undefined);
      // 그 위에 이름 없는 손님이 다시 올리면 앞 주인 이름이 남지 않는다.
      await audit.recordEntryGuestUpload(a.layoutKey, null);
      const guestAgain = await audit.getEntryAudit(a.layoutKey);
      assert.equal(guestAgain?.uploadedBy, undefined);
      assert.equal(guestAgain?.uploadedByGuest, true);
    });
  });
});

test("배선: 업로드 라우트·속성 API·화면 셋이 손님 이름을 같은 규칙으로 다룬다 (#17 B-4)", async () => {
  const [route, properties, view, mobile, admin, publicView, desktopCss, mobileCss] =
    await Promise.all([
      read("src/app/api/public-folder/[token]/upload/route.ts"),
      read("src/app/api/drive/properties/route.ts"),
      read("src/app/files/FilesView.tsx"),
      read("src/app/files/MobileFilesView.tsx"),
      read("src/app/admin/AdminView.tsx"),
      read("src/app/public/[token]/PublicFolderView.tsx"),
      read("src/app/files/desktop.module.css"),
      read("src/app/files/mobile.module.css"),
    ]);

  // 서버: 헤더에서 읽고, 업로드 예약 전에 거른다. 쿼리 sender는 읽지 않는다.
  const parseAt = route.indexOf("parseGuestNameHeader(req.headers.get(GUEST_NAME_HEADER))");
  assert.ok(parseAt > 0, "헤더 이름을 parseGuestNameHeader로 정제한다");
  assert.ok(parseAt < route.indexOf("reserveUpload("), "예약 전에 거른다");
  assert.doesNotMatch(route, /searchParams\.get\("sender"\)/);
  assert.match(route, /recordEntryGuestUploadAfter\(entry\.layoutKey, sender\)/);
  assert.match(route, /guest: true \}/);
  assert.match(route, /group: `public:\$\{resolved\.folder\.id\}`/);

  assert.match(properties, /uploadedByGuest: audit\?\.uploadedByGuest === true/);

  // 데스크 속성 창·모바일 속성·활동 기록 모두 같은 표시 함수.
  assert.match(view, /guestDisplayName\(properties\.data\.uploadedBy, t\)/);
  assert.match(mobile, /guestDisplayName\(sheetInfo\.uploadedBy, t\)/);
  assert.match(admin, /entry\.guest === true\s*\?\s*guestDisplayName\(/);
  assert.match(admin, /t\("\{name\} 등 \{count\}개"/);

  // 방문자 화면: 두 입력(데스크톱·모바일), 상한, 공개 폴더별 기억, 헤더로 보내기.
  assert.equal(publicView.match(/maxLength=\{MAX_GUEST_NAME_LENGTH\}/g)?.length, 2);
  assert.match(publicView, /`sharedesk-public-sender-name:\$\{token\}`/);
  assert.match(publicView, /\[GUEST_NAME_HEADER\]: encodeURIComponent\(senderName\)/);
  assert.doesNotMatch(publicView, /&sender=/);
  assert.match(publicView, /const \[sender, setSender\] = useState\(""\)/);
  assert.match(publicView, /className=\{desktopStyles\.publicSender\}/);
  assert.match(publicView, /className=\{mobileStyles\.senderInput\}/);
  assert.match(desktopCss, /\.publicSender \{/);
  assert.match(mobileCss, /\.senderInput \{/);
});

test("i18n: 손님 표시·보내는 사람 문구가 네 사전에 있다 (#17 B-4)", async () => {
  const [{ englishDictionary }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  const EN = englishDictionary();
  for (const key of [
    "손님",
    "손님 · {name}",
    "보내는 사람",
    "보내는 사람 (선택)",
    "이름 (선택)",
    `보내는 사람 이름은 ${MAX_GUEST_NAME_LENGTH}자까지 쓸 수 있습니다`,
    "{name} 등 {count}개",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
