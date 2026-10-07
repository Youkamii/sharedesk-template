import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 공개 폴더 안내문(#17 B-5): "안내문 보이기"를 켠 폴더만 그 폴더의 메모를
// 방문자에게 보여 준다. 꺼져 있으면 공개 표면(공개 목록 API·방문자 화면)에
// 메모가 절대 나가지 않는다. 켜져 있어도 목록 폴링은 지문만 싣고 본문은 바뀔
// 때만 — 실제 함수·핸들러를 돌리고 배선을 고정한다.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

const NOTE = "제출 마감은 금요일 18시입니다.\n파일 이름에 <팀 이름>을 넣어 주세요.\n\n  — 운영팀";

async function withLocalStorage(run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-public-note-"));
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

test("등록부: 안내문 보이기는 기본 꺼짐이고 켜고 끌 수 있다 (#17 B-5)", async () => {
  await withLocalStorage(async () => {
    const [{ getAdapter }, { ROOT_ID }, publicFolders, space] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/public-folders"),
      import("../src/lib/space-store"),
    ]);
    await space.runWithSpace(null, async () => {
      const adapter = getAdapter();
      const folder = await adapter.createFolder(ROOT_ID, "제출함");
      const created = await publicFolders.addPublicFolder({
        folderId: folder.id,
        folderIdentity: folder.layoutKey,
        name: "제출함",
        createdByUserId: "u-admin",
      });
      assert.equal(created.showNote, false, "새 공개 폴더는 꺼짐");

      const on = await publicFolders.updatePublicFolder(created.id, { showNote: true });
      assert.equal(on?.showNote, true);
      assert.equal((await publicFolders.getPublicFolder(created.id))?.showNote, true);
      const off = await publicFolders.updatePublicFolder(created.id, { showNote: false });
      assert.equal(off?.showNote, false);

      // 옛 레코드(필드 없음)·이상한 값은 꺼짐으로 읽는다.
      const rewrite = async (
        change: (item: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        const state = await adapter.readStateVersioned<{
          version: 1;
          folders: Array<Record<string, unknown>>;
        }>("public-folders.json");
        await adapter.compareAndSwapState(
          "public-folders.json",
          { version: 1, folders: state.value!.folders.map(change) },
          state.version,
        );
      };
      await rewrite((item) => {
        const { showNote: _drop, ...rest } = item;
        void _drop;
        return rest;
      });
      assert.equal((await publicFolders.getPublicFolder(created.id))?.showNote, false);
      await rewrite((item) => ({ ...item, showNote: "yes" }));
      assert.equal((await publicFolders.getPublicFolder(created.id))?.showNote, false);
    });
  });
});

test("관리 API 설정 파서: showNote는 불리언만 받는다 (#17 B-5)", async () => {
  const { parseSettingsPatch } = await import(
    "../src/app/api/admin/public-folders/route"
  );
  assert.deepEqual(parseSettingsPatch({ showNote: true }), { patch: { showNote: true } });
  assert.deepEqual(parseSettingsPatch({ showNote: false }), { patch: { showNote: false } });
  assert.deepEqual(parseSettingsPatch({ showNote: "true" }), { error: "잘못된 요청입니다" });
  assert.deepEqual(parseSettingsPatch({ showNote: 1 }), { error: "잘못된 요청입니다" });
  // 보내지 않으면 건드리지 않는다.
  assert.deepEqual(parseSettingsPatch({ enabled: true }), { patch: { enabled: true } });
});

test("API: 켠 때만 안내문을 싣고, 폴링은 지문이 같으면 본문을 다시 보내지 않는다 (#17 B-5)", async () => {
  await withLocalStorage(async () => {
    const [
      { getAdapter },
      { ROOT_ID },
      publicFolders,
      folderNote,
      space,
      { NextRequest },
      route,
    ] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/public-folders"),
      import("../src/lib/folder-note"),
      import("../src/lib/space-store"),
      import("next/server"),
      import("../src/app/api/public-folder/[token]/route"),
    ]);
    await space.runWithSpace(null, async () => {
      const adapter = getAdapter();
      const folder = await adapter.createFolder(ROOT_ID, "제출함");
      await adapter.upload(folder.id, "양식.txt", "text/plain", new Blob(["양식"]).stream());
      const registered = await publicFolders.addPublicFolder({
        folderId: folder.id,
        folderIdentity: folder.layoutKey,
        name: "제출함",
        createdByUserId: "u-admin",
      });
      const list = async (knownHash?: string) => {
        const query = knownHash ? `?noteHash=${encodeURIComponent(knownHash)}` : "";
        const response = await route.GET(
          new NextRequest(`http://localhost/api/public-folder/${registered.id}${query}`),
          { params: Promise.resolve({ token: registered.id }) },
        );
        assert.equal(response.status, 200);
        const text = await response.text();
        return { text, body: JSON.parse(text) as Record<string, unknown> };
      };
      const setShowNote = (showNote: boolean) =>
        publicFolders.updatePublicFolder(registered.id, { showNote });
      const writeNote = async (content: string) => {
        const current = await folderNote.getFolderNote(folder.id);
        await folderNote.updateFolderNote(folder.id, content, current.version);
      };

      // 메모가 있어도 꺼져 있으면(기본) 내려주지 않는다 — 지문도 없다.
      await writeNote(NOTE);
      const off = await list();
      assert.equal("note" in off.body, false, "꺼짐: note 키 없음");
      assert.equal("noteHash" in off.body, false, "꺼짐: noteHash 키 없음");
      assert.doesNotMatch(off.text, /제출 마감/, "꺼짐: 응답 어디에도 메모 글이 없다");
      assert.equal((off.body.entries as unknown[]).length, 1, "목록은 그대로");

      // 켜면 처음(지문 없음)엔 원문 그대로 + 지문.
      await setShowNote(true);
      const first = await list();
      assert.equal(first.body.note, NOTE, "줄바꿈·꺾쇠 포함 원문 그대로");
      assert.equal(first.body.noteHash, publicFolders.publicFolderNoteHash(NOTE));
      const hash = first.body.noteHash as string;

      // 같은 지문으로 폴링하면 본문 없이 지문만.
      const again = await list(hash);
      assert.equal(again.body.noteHash, hash);
      assert.equal("note" in again.body, false);
      assert.doesNotMatch(again.text, /제출 마감/, "폴링 응답에 본문이 실리지 않는다");

      // 메모가 바뀌면 옛 지문으로 물어도 새 본문이 온다.
      await writeNote(`${NOTE}\n추가 안내`);
      const changed = await list(hash);
      assert.equal(changed.body.note, `${NOTE}\n추가 안내`);
      assert.notEqual(changed.body.noteHash, hash);

      // 켜져 있어도 메모가 비었거나 공백뿐이면 싣지 않는다.
      await writeNote("   \n  ");
      const blank = await list(changed.body.noteHash as string);
      assert.equal("note" in blank.body, false);
      assert.equal("noteHash" in blank.body, false);

      // 다시 끄면 즉시 사라진다.
      await writeNote(NOTE);
      assert.equal((await list()).body.note, NOTE);
      await setShowNote(false);
      const offAgain = await list(hash);
      assert.equal("note" in offAgain.body, false);
      assert.equal("noteHash" in offAgain.body, false);
      assert.doesNotMatch(offAgain.text, /제출 마감/);

      // 페이지·API가 함께 쓰는 입구도 같은 판정.
      assert.equal(
        await publicFolders.readPublicFolderNote({ showNote: false, folderId: folder.id }),
        null,
      );
      assert.equal(
        await publicFolders.readPublicFolderNote({ showNote: true, folderId: folder.id }),
        NOTE,
      );
      // 메모를 읽지 못해도(대상이 없음) 방문자 화면을 깨뜨리지 않는다.
      assert.equal(
        await publicFolders.readPublicFolderNote({ showNote: true, folderId: "없는-폴더" }),
        null,
      );
    });
  });
});

test("배선: 공개 표면은 같은 입구로만 메모를 읽는다 (#17 B-5)", async () => {
  const [page, route, lib] = await Promise.all([
    read("src/app/public/[token]/page.tsx"),
    read("src/app/api/public-folder/[token]/route.ts"),
    read("src/lib/public-folders.ts"),
  ]);

  // 입구는 하나: showNote가 아니면 메모를 읽지도 않는다.
  const gate = lib.slice(lib.indexOf("export async function readPublicFolderNote("));
  assert.ok(gate.length > 0);
  assert.ok(
    gate.indexOf("folder.showNote !== true") < gate.indexOf("getFolderNote("),
    "토글 검사가 메모 읽기보다 먼저",
  );

  // 페이지: 접근 판정·대상 확인 뒤에 같은 입구로 읽어 첫 화면에 넘긴다(지문과 함께).
  const targetAt = page.indexOf("resolvePublicFolderTarget(folder)");
  const noteAt = page.indexOf("readPublicFolderNote(folder)");
  assert.ok(targetAt > 0 && noteAt > targetAt, "판정·실체 확인 뒤에 읽는다");
  assert.match(page, /initialNote=\{resolved\.note\}/);
  assert.match(page, /initialNoteHash=/);

  // 공개 목록 API: 같은 입구, 지문은 켜져 있을 때만, 본문은 지문이 다를 때만.
  assert.match(route, /readPublicFolderNote\(resolved\.folder\)/);
  assert.match(route, /searchParams\.get\("noteHash"\)/);
  assert.match(route, /knownHash === noteHash \? \{\} : \{ note \}/);

  // 공개 표면은 폴더 메모를 직접 읽지 않는다 — 입구를 우회할 길이 없다.
  const publicSurfaces = [
    "src/app/public/[token]/page.tsx",
    "src/app/public/[token]/PublicFolderView.tsx",
    ...(await readdir(new URL("../src/app/api/public-folder/[token]/", import.meta.url), {
      recursive: true,
    }))
      .filter((file) => String(file).endsWith(".ts"))
      .map((file) => `src/app/api/public-folder/[token]/${String(file).replaceAll("\\", "/")}`),
    "src/app/api/public-folders/route.ts",
  ];
  assert.ok(publicSurfaces.length >= 7, "public-folder API 파일을 다 모았다");
  for (const surface of publicSurfaces) {
    const source = await read(surface);
    assert.doesNotMatch(source, /getFolderNote|@\/lib\/folder-note|\/api\/folder-note/, surface);
  }
  // 사이드바 목록(공개 폴더 입장)은 안내문을 싣지 않는다.
  assert.doesNotMatch(
    await read("src/app/api/public-folders/route.ts"),
    /readPublicFolderNote|getFolderNote/,
  );
});

test("배선: 방문자 화면은 안내문을 아이콘 판 위의 띠로, 6줄 접기로 그린다 (#17 B-5)", async () => {
  const [view, desktopCss, mobileCss] = await Promise.all([
    read("src/app/public/[token]/PublicFolderView.tsx"),
    read("src/app/files/desktop.module.css"),
    read("src/app/files/mobile.module.css"),
  ]);

  // 폴링은 아는 지문을 싣고, 지문이 없으면 지우고 본문이 오면 바꾼다.
  assert.match(view, /\?noteHash=\$\{encodeURIComponent\(knownHash\)\}/);
  assert.match(view, /typeof body\.noteHash !== "string"/);
  assert.match(view, /typeof body\.note === "string"/);

  // 데스크톱: 띠가 판과 같은 세로 흐름(stage) 안, 판보다 먼저 — 아이콘을 덮지 않는다.
  const stageAt = view.indexOf("className={desktopStyles.publicStage}");
  const bandAt = view.indexOf("className={desktopStyles.publicNote}");
  const canvasAt = view.indexOf("desktopStyles.rootCanvas");
  assert.ok(stageAt > 0 && stageAt < bandAt && bandAt < canvasAt);
  assert.match(view, /className=\{mobileStyles\.publicNote\}/);
  const publicNoteRule = desktopCss.match(/\n\.publicNote \{[^}]*\}/)?.[0] ?? "";
  assert.ok(publicNoteRule, "데스크톱 띠 규칙");
  assert.doesNotMatch(publicNoteRule, /position: absolute/, "떠 있는 쪽지가 아니다");
  assert.match(desktopCss, /\.publicStage > \.rootCanvas \{[^}]*position: relative;/);

  // 글자 그대로(텍스트 노드), 처음 6줄, 넘치면 더 보기/접기.
  assert.doesNotMatch(view, /dangerouslySetInnerHTML/);
  assert.match(view, /data-collapsed=\{expanded \? "false" : "true"\}/);
  assert.match(view, /expanded \? t\("접기"\) : t\("더 보기"\)/);
  for (const css of [desktopCss, mobileCss]) {
    assert.match(css, /\.publicNote p \{[^}]*white-space: pre-wrap;/);
    assert.match(css, /\.publicNote p\[data-collapsed="true"\] \{[^}]*-webkit-line-clamp: 6;/);
  }
});

test("배선: 관리 패널에 안내문 보이기 설정 (#17 B-5)", async () => {
  const panel = await read("src/app/admin/PublicFoldersPanel.tsx");
  assert.match(panel, /showNote: folder\.showNote,/);
  assert.match(panel, /body\.showNote = form\.showNote/);
  assert.match(panel, /t\("안내문 보이기"\)/);
  assert.match(panel, /value=\{form\.showNote \? "on" : "off"\}/);
});

test("i18n: 안내문 문구가 네 사전에 있다 (#17 B-5)", async () => {
  const [{ englishDictionary }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  const EN = englishDictionary();
  for (const key of [
    "안내문",
    "안내문 보이기",
    "더 보기",
    "접기",
    "켜면 이 폴더의 메모를 방문자 화면 위쪽에 읽기 전용으로 보여 줍니다. 메모는 데스크에서 이 폴더를 열고 ‘폴더 메모’로 씁니다.",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
