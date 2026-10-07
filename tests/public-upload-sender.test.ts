import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { translate } from "../src/lib/i18n";
import {
  guestDisplayName,
  MAX_GUEST_NAME_LENGTH,
  parseGuestName,
} from "../src/lib/nickname";

// 공개 폴더 외부 업로드의 "보내는 사람" 이름(#17 B-4): 정제·검증 순수 함수,
// 실제 업로드 핸들러를 돌려 항목 내력(손님 표시)·활동 기록이 남는지, 화면 배선.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("보내는 사람 이름: 보이지 않는 문자를 걷고 공백을 접고 40자까지 받는다 (#17 B-4)", () => {
  assert.equal(MAX_GUEST_NAME_LENGTH, 40);
  // 보내지 않았거나 비었으면 이름 없음(null) — 업로드는 그대로 받는다.
  assert.equal(parseGuestName(null), null);
  assert.equal(parseGuestName(undefined), null);
  assert.equal(parseGuestName(""), null);
  assert.equal(parseGuestName("   \n\t "), null);
  // 문자열이 아니면 받을 수 없는 값.
  assert.equal(parseGuestName(42), undefined);
  assert.equal(parseGuestName(["홍길동"]), undefined);

  // 띄어쓰기·괄호는 닉네임과 달리 받는다.
  assert.equal(parseGuestName("  홍길동 (디자인팀)  "), "홍길동 (디자인팀)");
  // 줄바꿈·탭은 한 칸으로 접는다.
  assert.equal(parseGuestName("홍길동\n\t디자인팀"), "홍길동 디자인팀");
  // 제어문자(C0·C1)는 지운다.
  assert.equal(parseGuestName("홍\u0000길\u0007동\u0085"), "홍길동");
  // 방향 제어(RLO 등)로 글자 순서를 뒤집어 보이게 하는 것을 막는다.
  assert.equal(parseGuestName("kim‮gpj.exe"), "kimgpj.exe");
  assert.equal(parseGuestName("⁦이름⁩‏"), "이름");
  // zero-width·BOM도 걷는다. 지운 자리에 공백이 겹치면 하나로.
  assert.equal(parseGuestName("a ​ b﻿"), "a b");
  // 보이지 않는 문자만 있었다면 이름 없음.
  assert.equal(parseGuestName("‮​"), null);

  // 길이는 정제한 뒤 센다 — 정확히 40자는 받고, 41자는 거부.
  assert.equal(parseGuestName("가".repeat(40)), "가".repeat(40));
  assert.equal(parseGuestName("가".repeat(41)), undefined);
  assert.equal(parseGuestName(`${"가".repeat(40)}‮​`), "가".repeat(40));
});

test("손님 표시: 이름이 있으면 '손님 · 이름', 없으면 '손님' (#17 B-4)", () => {
  const ko = (text: string, vars?: Record<string, string | number>) =>
    translate("ko", text, vars);
  const en = (text: string, vars?: Record<string, string | number>) =>
    translate("en", text, vars);
  assert.equal(guestDisplayName("홍길동", ko), "손님 · 홍길동");
  assert.equal(guestDisplayName(null, ko), "손님");
  assert.equal(guestDisplayName("", ko), "손님");
  assert.equal(guestDisplayName(undefined, ko), "손님");
  assert.equal(guestDisplayName("Kim", en), "Guest · Kim");
  assert.equal(guestDisplayName(null, en), "Guest");
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

test("API: 공개 폴더 업로드가 보낸 사람 이름을 손님 표시와 함께 내력·활동에 남긴다 (#17 B-4)", async () => {
  await withLocalStorage(async () => {
    const [
      { getAdapter },
      { ROOT_ID },
      publicFolders,
      audit,
      activity,
      { NextRequest },
      route,
    ] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/public-folders"),
      import("../src/lib/entry-audit"),
      import("../src/lib/activity"),
      import("next/server"),
      import("../src/app/api/public-folder/[token]/upload/route"),
    ]);
    const adapter = getAdapter();
    const folder = await adapter.createFolder(ROOT_ID, "받는곳");
    const registered = await publicFolders.addPublicFolder({
      folderId: folder.id,
      folderIdentity: folder.layoutKey,
      name: "받는곳",
      createdByUserId: "u-admin",
    });
    const upload = (name: string, body: string, sender?: string) => {
      const bytes = new TextEncoder().encode(body);
      const query = new URLSearchParams({ name });
      if (sender !== undefined) query.set("sender", sender);
      return route.POST(
        new NextRequest(
          `http://localhost/api/public-folder/${registered.id}/upload?${query}`,
          {
            method: "POST",
            body: bytes,
            headers: {
              "content-type": "text/plain",
              "content-length": String(bytes.byteLength),
            },
          },
        ),
        { params: Promise.resolve({ token: registered.id }) },
      );
    };
    const entryNamed = async (name: string) =>
      (await adapter.list(folder.id)).find((entry) => entry.name === name);

    // 이름을 넣어 올리면(정제 대상 문자 포함) 손님 표시와 정제된 이름이 남는다.
    const named = await upload("a.txt", "from guest", "  홍길동‮ (디자인팀)\n ");
    assert.equal(named.status, 201);
    const a = await entryNamed("a.txt");
    assert.ok(a);
    const aAudit = await eventually(
      async () => await audit.getEntryAudit(a.layoutKey),
      "a.txt 내력",
    );
    assert.equal(aAudit.uploadedBy, "홍길동 (디자인팀)");
    assert.equal(aAudit.uploadedByGuest, true);
    assert.ok(aAudit.uploadedAt);
    const aActivity = await eventually(
      async () =>
        (await activity.listActivity()).find((entry) => entry.name === "a.txt"),
      "a.txt 활동",
    );
    assert.deepEqual(
      { actorName: aActivity.actorName, action: aActivity.action, guest: aActivity.guest },
      { actorName: "홍길동 (디자인팀)", action: "upload", guest: true },
    );

    // 이름 없이 올려도 "손님이 올렸다"는 남는다.
    const anonymous = await upload("b.txt", "no name");
    assert.equal(anonymous.status, 201);
    const b = await entryNamed("b.txt");
    assert.ok(b);
    const bAudit = await eventually(
      async () => await audit.getEntryAudit(b.layoutKey),
      "b.txt 내력",
    );
    assert.equal(bAudit.uploadedBy, undefined);
    assert.equal(bAudit.uploadedByGuest, true);
    const bActivity = await eventually(
      async () =>
        (await activity.listActivity()).find((entry) => entry.name === "b.txt"),
      "b.txt 활동",
    );
    assert.equal(bActivity.actorName, "");
    assert.equal(bActivity.guest, true);

    // 41자 이름은 400이고 파일도 만들지 않는다(예약 전에 거른다).
    const tooLong = await upload("c.txt", "rejected", "가".repeat(41));
    assert.equal(tooLong.status, 400);
    assert.equal(
      (await tooLong.json()).error,
      "보내는 사람 이름은 40자까지 쓸 수 있습니다",
    );
    assert.equal(await entryNamed("c.txt"), undefined);

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

    // 멤버 활동 기록에는 guest가 붙지 않는다.
    await activity.recordActivity({ name: "멤버" }, "mkdir", "새 폴더");
    const memberActivity = (await activity.listActivity()).find(
      (entry) => entry.name === "새 폴더",
    );
    assert.equal(memberActivity?.guest, undefined);
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

  // 서버 검증·정제는 업로드 예약 전에 끝난다.
  const parseAt = route.indexOf(
    'parseGuestName(req.nextUrl.searchParams.get("sender"))',
  );
  assert.ok(parseAt > 0, "sender를 parseGuestName으로 정제한다");
  assert.ok(parseAt < route.indexOf("reserveUpload({"), "예약 전에 거른다");
  assert.match(route, /if \(sender === undefined\) \{[\s\S]*?status: 400/);
  assert.match(route, /recordEntryGuestUploadAfter\(entry\.layoutKey, sender\)/);
  assert.match(
    route,
    /recordActivityAfter\(\{ name: sender \?\? "", guest: true \}, "upload", entry\.name\)/,
  );

  assert.match(properties, /uploadedByGuest: audit\?\.uploadedByGuest === true/);

  // 데스크 속성 창·모바일 속성·활동 기록 모두 같은 표시 함수.
  assert.match(view, /guestDisplayName\(properties\.data\.uploadedBy, t\)/);
  assert.match(mobile, /guestDisplayName\(sheetInfo\.uploadedBy, t\)/);
  assert.match(
    admin,
    /entry\.guest === true\s*\?\s*guestDisplayName\(entry\.actorName \|\| null, t\)/,
  );

  // 방문자 화면: 데스크톱 작업표시줄·모바일 dock 두 곳의 입력, 40자, 브라우저 기억.
  assert.match(publicView, /const SENDER_NAME_KEY = "sharedesk-public-sender-name";/);
  assert.equal(
    publicView.match(/maxLength=\{MAX_GUEST_NAME_LENGTH\}/g)?.length,
    2,
  );
  assert.match(publicView, /window\.localStorage\.setItem\(SENDER_NAME_KEY, next\)/);
  assert.match(publicView, /&sender=\$\{encodeURIComponent\(senderName\)\}/);
  assert.match(
    publicView,
    /upload\?name=\$\{encodeURIComponent\(file\.name\)\}\$\{senderQuery\}/,
  );
  assert.match(publicView, /className=\{desktopStyles\.publicSender\}/);
  assert.match(publicView, /className=\{mobileStyles\.senderInput\}/);
  assert.match(desktopCss, /\.publicSender \{/);
  assert.match(mobileCss, /\.senderInput \{/);
});

test("i18n: 손님 표시·보내는 사람 문구가 네 사전에 있다 (#17 B-4)", async () => {
  const [{ EN_FILES }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n-en-files"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  for (const key of [
    "손님",
    "손님 · {name}",
    "보내는 사람",
    "보내는 사람 (선택)",
    "이름 (선택)",
    "보내는 사람 이름은 40자까지 쓸 수 있습니다",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN_FILES, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
