import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 공개 폴더 안내문(#17 B-5): "안내문 보이기"를 켠 폴더만 그 폴더의 메모를
// 방문자에게 보여 준다. 꺼져 있으면 공개 표면(공개 목록 API·방문자 화면)에
// 메모가 절대 나가지 않는다 — 실제 함수·핸들러를 돌리고 배선을 고정한다.

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
      const state = await adapter.readStateVersioned<{
        version: 1;
        folders: Array<Record<string, unknown>>;
      }>("public-folders.json");
      await adapter.compareAndSwapState(
        "public-folders.json",
        {
          version: 1,
          folders: state.value!.folders.map((item) => {
            const { showNote: _drop, ...rest } = item;
            void _drop;
            return rest;
          }),
        },
        state.version,
      );
      assert.equal((await publicFolders.getPublicFolder(created.id))?.showNote, false);
      const legacy = await adapter.readStateVersioned<{
        version: 1;
        folders: Array<Record<string, unknown>>;
      }>("public-folders.json");
      await adapter.compareAndSwapState(
        "public-folders.json",
        {
          version: 1,
          folders: legacy.value!.folders.map((item) => ({ ...item, showNote: "yes" })),
        },
        legacy.version,
      );
      assert.equal((await publicFolders.getPublicFolder(created.id))?.showNote, false);
    });
  });
});

test("관리 API 설정 파서: showNote는 불리언만 받는다 (#17 B-5)", async () => {
  const { parseSettingsPatch } = await import(
    "../src/app/api/admin/public-folders/route"
  );
  assert.deepEqual(parseSettingsPatch({ showNote: true }), {
    patch: { showNote: true },
  });
  assert.deepEqual(parseSettingsPatch({ showNote: false }), {
    patch: { showNote: false },
  });
  assert.deepEqual(parseSettingsPatch({ showNote: "true" }), {
    error: "잘못된 요청입니다",
  });
  assert.deepEqual(parseSettingsPatch({ showNote: 1 }), {
    error: "잘못된 요청입니다",
  });
  // 보내지 않으면 건드리지 않는다.
  assert.deepEqual(parseSettingsPatch({ enabled: true }), {
    patch: { enabled: true },
  });
});

test("API: 공개 목록은 안내문을 켠 때만 메모를 싣고, 끄면 note 키조차 없다 (#17 B-5)", async () => {
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
    const adapter = getAdapter();
    const { folder, registered } = await space.runWithSpace(null, async () => {
      const created = await adapter.createFolder(ROOT_ID, "제출함");
      await adapter.upload(
        created.id,
        "양식.txt",
        "text/plain",
        new Blob(["양식"]).stream(),
      );
      return {
        folder: created,
        registered: await publicFolders.addPublicFolder({
          folderId: created.id,
          folderIdentity: created.layoutKey,
          name: "제출함",
          createdByUserId: "u-admin",
        }),
      };
    });
    const list = async () => {
      const response = await route.GET(
        new NextRequest(`http://localhost/api/public-folder/${registered.id}`),
        { params: Promise.resolve({ token: registered.id }) },
      );
      assert.equal(response.status, 200);
      const text = await response.text();
      return { text, body: JSON.parse(text) as Record<string, unknown> };
    };
    const setShowNote = (showNote: boolean) =>
      space.runWithSpace(null, () =>
        publicFolders.updatePublicFolder(registered.id, { showNote }),
      );

    // 메모가 있어도 꺼져 있으면(기본) 내려주지 않는다.
    await space.runWithSpace(null, () =>
      folderNote.updateFolderNote(folder.id, NOTE, null),
    );
    const off = await list();
    assert.equal("note" in off.body, false, "꺼짐: note 키 없음");
    assert.doesNotMatch(off.text, /제출 마감/, "꺼짐: 응답 어디에도 메모 글이 없다");
    assert.equal((off.body.entries as unknown[]).length, 1, "목록은 그대로");

    // 켜면 메모 원문 그대로(줄바꿈·꺾쇠 포함 — 해석·변형 없음).
    await setShowNote(true);
    const on = await list();
    assert.equal(on.body.note, NOTE);

    // 켜져 있어도 메모가 비었거나 공백뿐이면 싣지 않는다.
    const current = await space.runWithSpace(null, () =>
      folderNote.getFolderNote(folder.id),
    );
    await space.runWithSpace(null, () =>
      folderNote.updateFolderNote(folder.id, "   \n  ", current.version),
    );
    assert.equal("note" in (await list()).body, false, "빈 메모는 싣지 않는다");

    // 다시 끄면 즉시 사라진다.
    const blank = await space.runWithSpace(null, () =>
      folderNote.getFolderNote(folder.id),
    );
    await space.runWithSpace(null, () =>
      folderNote.updateFolderNote(folder.id, NOTE, blank.version),
    );
    assert.equal((await list()).body.note, NOTE);
    await setShowNote(false);
    const offAgain = await list();
    assert.equal("note" in offAgain.body, false);
    assert.doesNotMatch(offAgain.text, /제출 마감/);

    // 페이지·API가 함께 쓰는 입구도 같은 판정.
    assert.equal(
      await space.runWithSpace(null, () =>
        publicFolders.readPublicFolderNote({ showNote: false, folderId: folder.id }),
      ),
      null,
    );
    assert.equal(
      await space.runWithSpace(null, () =>
        publicFolders.readPublicFolderNote({ showNote: true, folderId: folder.id }),
      ),
      NOTE,
    );
    // 메모를 읽지 못해도(대상이 없음) 방문자 화면을 깨뜨리지 않는다.
    assert.equal(
      await space.runWithSpace(null, () =>
        publicFolders.readPublicFolderNote({ showNote: true, folderId: "없는-폴더" }),
      ),
      null,
    );
  });
});

test("배선: 방문자 화면은 같은 입구로 읽고, 메모를 글자 그대로(줄바꿈만) 그린다 (#17 B-5)", async () => {
  const [page, view, route, lib, desktopCss, mobileCss] = await Promise.all([
    read("src/app/public/[token]/page.tsx"),
    read("src/app/public/[token]/PublicFolderView.tsx"),
    read("src/app/api/public-folder/[token]/route.ts"),
    read("src/lib/public-folders.ts"),
    read("src/app/files/desktop.module.css"),
    read("src/app/files/mobile.module.css"),
  ]);

  // 입구는 하나: showNote가 아니면 메모를 읽지도 않는다.
  assert.match(
    lib,
    /export async function readPublicFolderNote\([\s\S]*?\{\s*if \(folder\.showNote !== true\) return null;/,
  );

  // 페이지: 접근 판정·대상 확인 뒤에 같은 입구로 읽어 첫 화면에 넘긴다.
  const resolvedBlock = page.match(/const resolved = await runWithSpace\(null, async \(\) => \{([\s\S]*?)\n  \}\);/)?.[1] ?? "";
  assert.ok(resolvedBlock, "페이지의 판정 블록");
  const targetAt = resolvedBlock.indexOf("resolvePublicFolderTarget(folder)");
  const noteAt = resolvedBlock.indexOf("note: await readPublicFolderNote(folder)");
  assert.ok(targetAt > 0 && noteAt > targetAt, "판정·실체 확인 뒤에 읽는다");
  assert.match(page, /initialNote=\{resolved\.note\}/);

  // 공개 목록 API: 같은 입구, null이면 note 키 자체를 싣지 않는다.
  assert.match(route, /const note = await readPublicFolderNote\(resolved\.folder\);/);
  assert.match(route, /\.\.\.\(note !== null \? \{ note \} : \{\}\)/);

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
  for (const surface of publicSurfaces) {
    const source = await read(surface);
    assert.doesNotMatch(source, /getFolderNote|@\/lib\/folder-note|folder-note\.json|\/api\/folder-note/, surface);
  }
  // 사이드바 목록(공개 폴더 입장)은 안내문을 싣지 않는다.
  assert.doesNotMatch(
    await read("src/app/api/public-folders/route.ts"),
    /readPublicFolderNote|note/,
  );

  // 화면: 목록을 받은 뒤엔 목록의 note를 따르고(끄면 다음 폴링에 사라짐),
  // 마크다운·HTML 해석 없이 텍스트 노드로 그린다.
  assert.match(
    view,
    /const note = listing\s*\?\s*typeof listing\.note === "string" && listing\.note\.trim\(\)\s*\?\s*listing\.note\s*:\s*null\s*:\s*initialNote;/,
  );
  assert.match(view, /<aside className=\{desktopStyles\.publicNote\} aria-label=\{t\("안내문"\)\}>/);
  assert.match(view, /<section className=\{mobileStyles\.publicNote\} aria-label=\{t\("안내문"\)\}>/);
  assert.equal(view.match(/<p>\{note\}<\/p>/g)?.length, 2, "데스크톱·모바일 둘 다 글자 그대로");
  assert.doesNotMatch(view, /dangerouslySetInnerHTML/);
  assert.match(desktopCss, /\.publicNote p \{[\s\S]*?white-space: pre-wrap;/);
  assert.match(mobileCss, /\.publicNote p \{[\s\S]*?white-space: pre-wrap;/);
});

test("배선: 관리 패널에 안내문 보이기 설정 (#17 B-5)", async () => {
  const panel = await read("src/app/admin/PublicFoldersPanel.tsx");
  assert.match(panel, /showNote: folder\.showNote === true/);
  assert.match(
    panel,
    /if \(form\.showNote !== baseline\.showNote\) body\.showNote = form\.showNote;/,
  );
  assert.match(panel, /<span>\{t\("안내문 보이기"\)\}<\/span>/);
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
    "켜면 이 폴더의 메모를 방문자 화면 위쪽에 읽기 전용으로 보여 줍니다. 메모는 데스크에서 이 폴더를 열고 ‘폴더 메모’로 씁니다.",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
