import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { roleAtLeast } from "../src/lib/roles";

// 공개 폴더(#10): 등록부·접근 판정·폴더별 상한 집행의 회귀 테스트.
// 판정 함수는 실제 함수를 그대로 돌리고, 상한은 reserveUpload를 실측한다.

const SESSION_SECRET = ["test-", "public-folder-secret-32-characters!!"].join("");

type Mods = {
  publicFolders: typeof import("../src/lib/public-folders");
  quota: typeof import("../src/lib/storage-quota");
  storage: typeof import("../src/lib/storage");
  space: typeof import("../src/lib/space-store");
};

async function withEnv(run: (mods: Mods) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-public-"));
  const applied: Record<string, string> = {
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: root,
    SESSION_SECRET,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(applied)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await run({
      publicFolders: await import("../src/lib/public-folders"),
      quota: await import("../src/lib/storage-quota"),
      storage: await import("../src/lib/storage"),
      space: await import("../src/lib/space-store"),
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function session(overrides: Partial<{
  userId: string;
  role: "admin" | "editor" | "uploader" | "viewer";
  isAdmin: boolean;
  isGuest: boolean;
}> = {}) {
  return {
    userId: overrides.userId ?? "u-1",
    role: overrides.role ?? "viewer",
    isAdmin: overrides.isAdmin ?? false,
    isGuest: overrides.isGuest ?? false,
  };
}

test("역할 서열은 viewer < uploader < editor < admin (배열 순서 함정 방지)", () => {
  assert.equal(roleAtLeast("viewer", "viewer"), true);
  assert.equal(roleAtLeast("viewer", "uploader"), false);
  assert.equal(roleAtLeast("uploader", "uploader"), true);
  assert.equal(roleAtLeast("uploader", "editor"), false);
  assert.equal(roleAtLeast("editor", "uploader"), true);
  assert.equal(roleAtLeast("admin", "editor"), true);
});

test("입력 검증 — 이름·개수·시각·토큰", async () => {
  await withEnv(async ({ publicFolders }) => {
    const {
      parsePublicFolderName,
      parsePublicFolderFileLimit,
      parsePublicFolderTime,
      parsePublicFolderToken,
    } = publicFolders;
    assert.equal(parsePublicFolderName("자료 나눔"), "자료 나눔");
    assert.equal(parsePublicFolderName("  trim  "), "trim");
    assert.equal(parsePublicFolderName(""), null);
    assert.equal(parsePublicFolderName("a/b"), null);
    assert.equal(parsePublicFolderName(".hidden"), null);
    assert.equal(parsePublicFolderName("a".repeat(41)), null);

    assert.equal(parsePublicFolderFileLimit(null), null);
    assert.equal(parsePublicFolderFileLimit(10), 10);
    assert.equal(parsePublicFolderFileLimit(0), undefined);
    assert.equal(parsePublicFolderFileLimit(10001), undefined);
    assert.equal(parsePublicFolderFileLimit("10"), undefined);

    assert.equal(parsePublicFolderTime(null), null);
    assert.equal(
      parsePublicFolderTime("2026-09-01T00:00:00.000Z"),
      "2026-09-01T00:00:00.000Z",
    );
    assert.equal(parsePublicFolderTime("nonsense"), undefined);

    assert.equal(parsePublicFolderToken("f".repeat(48)), "f".repeat(48));
    assert.equal(parsePublicFolderToken("F".repeat(48)), null);
    assert.equal(parsePublicFolderToken("f".repeat(47)), null);
  });
});

test("접근 판정 — 기간·enabled·완전 공개·제한 공개(OR)", async () => {
  await withEnv(async ({ publicFolders }) => {
    const { publicFolderAccess } = publicFolders;
    const base = {
      enabled: true,
      opensAt: null as string | null,
      closesAt: null as string | null,
      minRole: null as "editor" | "uploader" | "viewer" | null,
      userIds: [] as string[],
    };
    const now = new Date("2026-08-26T12:00:00.000Z");

    // 완전 공개 — 익명 포함 누구나.
    assert.equal(publicFolderAccess(base, null, now), "open");
    // 꺼짐·기간 밖은 닫힘.
    assert.equal(
      publicFolderAccess({ ...base, enabled: false }, null, now),
      "closed",
    );
    assert.equal(
      publicFolderAccess(
        { ...base, opensAt: "2026-08-26T13:00:00.000Z" },
        null,
        now,
      ),
      "closed",
    );
    assert.equal(
      publicFolderAccess(
        { ...base, closesAt: "2026-08-26T12:00:00.000Z" },
        null,
        now,
      ),
      "closed",
      "종료 시각 정각부터 닫힌다",
    );
    assert.equal(
      publicFolderAccess(
        {
          ...base,
          opensAt: "2026-08-26T11:00:00.000Z",
          closesAt: "2026-08-26T13:00:00.000Z",
        },
        null,
        now,
      ),
      "open",
    );

    // 제한 공개: 역할 최소선 + 개인 지정, OR 판정.
    const restricted = { ...base, minRole: "editor" as const, userIds: ["u-2"] };
    assert.equal(publicFolderAccess(restricted, null, now), "closed", "익명 거부");
    assert.equal(
      publicFolderAccess(restricted, session({ isGuest: true, role: "editor" }), now),
      "closed",
      "손님은 명단 멤버가 아니다",
    );
    assert.equal(
      publicFolderAccess(restricted, session({ role: "editor" }), now),
      "open",
      "역할 최소선 통과",
    );
    assert.equal(
      publicFolderAccess(restricted, session({ role: "uploader" }), now),
      "closed",
    );
    assert.equal(
      publicFolderAccess(restricted, session({ userId: "u-2", role: "viewer" }), now),
      "open",
      "개인 지정은 역할과 무관하게 통과(OR)",
    );
    assert.equal(
      publicFolderAccess(restricted, session({ isAdmin: true }), now),
      "open",
    );
  });
});

test("등록부 CRUD — 중복 folderId 거부·시간 역전 거부·해제", async () => {
  await withEnv(async ({ publicFolders, storage, space }) => {
    const adapter = storage.getAdapter();
    await space.runWithSpace(null, async () => {
      const folder = await adapter.createFolder("root", "드랍존");
      const created = await publicFolders.addPublicFolder({
        folderId: folder.id,
        folderIdentity: folder.layoutKey,
        name: "드랍존",
        createdByUserId: "u-admin",
        maxFiles: 5,
      });
      assert.match(created.id, /^[a-f0-9]{48}$/);
      assert.equal(created.enabled, true);

      assert.equal(
        (await publicFolders.getPublicFolder(created.id))?.folderId,
        folder.id,
      );
      assert.equal(
        (await publicFolders.findPublicFolderByFolderId(folder.id))?.id,
        created.id,
      );
      assert.equal(await publicFolders.isRegisteredPublicFolder(folder.id), true);

      // 같은 폴더를 두 번 등록할 수 없다.
      await assert.rejects(
        publicFolders.addPublicFolder({
          folderId: folder.id,
          folderIdentity: folder.layoutKey,
          name: "중복",
          createdByUserId: "u-admin",
        }),
        /이미 공개 폴더로 등록된 폴더/,
      );

      // 시간 역전은 등록·수정 모두 거부.
      await assert.rejects(
        publicFolders.updatePublicFolder(created.id, {
          opensAt: "2026-09-02T00:00:00.000Z",
          closesAt: "2026-09-01T00:00:00.000Z",
        }),
        /공개 종료 시각은 시작 시각보다 뒤/,
      );

      const renamed = await publicFolders.updatePublicFolder(created.id, {
        name: "새 이름",
        enabled: false,
      });
      assert.equal(renamed?.name, "새 이름");
      assert.equal(renamed?.enabled, false);

      assert.equal(await publicFolders.removePublicFolder(created.id), true);
      assert.equal(await publicFolders.getPublicFolder(created.id), null);
      assert.equal(
        await publicFolders.isRegisteredPublicFolder(folder.id),
        false,
      );
    });
  });
});

test("폴더별 상한 집행 — reserveUpload가 공개 폴더면 무조건 판정한다", async () => {
  await withEnv(async ({ publicFolders, quota, storage, space }) => {
    const adapter = storage.getAdapter();
    await space.runWithSpace(null, async () => {
      const folder = await adapter.createFolder("root", "공개함");
      await publicFolders.addPublicFolder({
        folderId: folder.id,
        folderIdentity: folder.layoutKey,
        name: "공개함",
        createdByUserId: "u-admin",
        maxFiles: 2,
        maxTotalBytes: 1024 * 1024, // 1MiB (parseOptionalByteLimit 하한)
        maxFileBytes: 1024 * 1024,
      });

      const reserve = (name: string, size: number, userId = "u-member") =>
        quota.reserveUpload({
          userId,
          parentId: folder.id,
          name,
          size,
          transport: "proxy",
          enforceMaxUpload: false,
        });

      // 데스크 한도(deskStorageLimitBytes)가 없어도 공개 폴더면 예약이 생긴다.
      const first = await reserve("a.bin", 10);
      assert.equal(typeof first, "string");

      // 파일 1개 크기 상한.
      await assert.rejects(
        reserve("big.bin", 1024 * 1024 + 1),
        /파일 크기 한도/,
      );

      // 개수 상한: 확정 파일 + 활성 예약을 함께 센다. (예약 1 + 신규 1 = 2 허용,
      // 셋째는 거부)
      const second = await reserve("b.bin", 10);
      assert.equal(typeof second, "string");
      await assert.rejects(reserve("c.bin", 10), /파일 개수 한도/);

      // 예약을 정산하고 실제 파일을 만들면 여전히 개수 상한이 실측으로 잡힌다.
      await quota.finishUploadReservation(first as string, "u-member");
      await quota.finishUploadReservation(second as string, "u-member");
      await adapter.upload(
        folder.id,
        "a.bin",
        "application/octet-stream",
        new Blob(["0123456789"]).stream(),
      );
      await adapter.upload(
        folder.id,
        "b.bin",
        "application/octet-stream",
        new Blob(["0123456789"]).stream(),
      );
      await assert.rejects(reserve("c.bin", 10), /파일 개수 한도/);
    });

    await space.runWithSpace(null, async () => {
      const folder = await adapter.createFolder("root", "용량함");
      await publicFolders.addPublicFolder({
        folderId: folder.id,
        folderIdentity: folder.layoutKey,
        name: "용량함",
        createdByUserId: "u-admin",
        maxTotalBytes: 1024 * 1024,
      });
      const first = await quota.reserveUpload({
        userId: "u-member",
        parentId: folder.id,
        name: "half.bin",
        size: 700 * 1024,
        transport: "proxy",
        enforceMaxUpload: false,
      });
      assert.equal(typeof first, "string");
      await assert.rejects(
        quota.reserveUpload({
          userId: "u-member",
          parentId: folder.id,
          name: "over.bin",
          size: 400 * 1024,
          transport: "proxy",
          enforceMaxUpload: false,
        }),
        /저장 용량 한도/,
      );
    });
  });
});

test("무세션 공개 업로드는 폴더당 동시 예약이 좁게 묶인다", async () => {
  await withEnv(async ({ publicFolders, quota, storage, space }) => {
    const adapter = storage.getAdapter();
    await space.runWithSpace(null, async () => {
      const folder = await adapter.createFolder("root", "던지기");
      const created = await publicFolders.addPublicFolder({
        folderId: folder.id,
        folderIdentity: folder.layoutKey,
        name: "던지기",
        createdByUserId: "u-admin",
      });
      const uploader = quota.PUBLIC_UPLOADER_PREFIX + created.id;
      for (let index = 0; index < 4; index += 1) {
        const id = await quota.reserveUpload({
          userId: uploader,
          parentId: folder.id,
          name: `f${index}.bin`,
          size: 10,
          transport: "proxy",
          enforceMaxUpload: false,
        });
        assert.equal(typeof id, "string");
      }
      await assert.rejects(
        quota.reserveUpload({
          userId: uploader,
          parentId: folder.id,
          name: "f5.bin",
          size: 10,
          transport: "proxy",
          enforceMaxUpload: false,
        }),
        /진행 중인 업로드가 많습니다/,
      );
      // 멤버(세션 userId)는 이 상한을 받지 않는다.
      const member = await quota.reserveUpload({
        userId: "u-member",
        parentId: folder.id,
        name: "member.bin",
        size: 10,
        transport: "proxy",
        enforceMaxUpload: false,
      });
      assert.equal(typeof member, "string");
    });
  });
});

test("배선: 공개 라우트는 러너 없이 기본 문맥, 가드·상한·면제 목록이 제자리에 있다", async () => {
  const read = (relative: string) =>
    readFile(new URL(`../${relative}`, import.meta.url), "utf8");

  for (const route of [
    "src/app/api/public-folder/[token]/route.ts",
    "src/app/api/public-folder/[token]/download/route.ts",
    "src/app/api/public-folder/[token]/upload/route.ts",
  ]) {
    const source = await read(route);
    assert.doesNotMatch(
      source,
      /runWithSession|runWithUploadRights|runWithEditRights|runWithAdmin/,
      `${route}는 무세션 공개 라우트다`,
    );
    assert.match(source, /runWithSpace\(null/, `${route}는 기본 문맥을 명시한다`);
  }
  const shared = await read("src/app/api/public-folder/[token]/shared.ts");
  assert.match(shared, /layoutKey !== folder\.folderIdentity/, "재사용 탈취 대조");
  assert.match(shared, /publicFolderAccess/, "접근 판정 사용");

  const download = await read(
    "src/app/api/public-folder/[token]/download/route.ts",
  );
  assert.match(download, /isWithin\(id, resolved\.folder\.folderId\)/);
  assert.match(download, /attachment; filename/);

  const upload = await read("src/app/api/public-folder/[token]/upload/route.ts");
  assert.match(upload, /PUBLIC_UPLOADER_PREFIX/);
  assert.match(upload, /exactSizeUploadStream/);
  assert.doesNotMatch(upload, /createUploadSession/, "direct 업로드는 제공하지 않는다");

  // 평평 가드 배선.
  const mkdir = await read("src/app/api/drive/mkdir/route.ts");
  assert.match(mkdir, /isRegisteredPublicFolder\(parentId\)/);
  const move = await read("src/app/api/drive/move/route.ts");
  assert.match(move, /isRegisteredPublicFolder\(body\.id\)/);
  assert.match(move, /isRegisteredPublicFolder\(body\.targetFolderId\)/);
  const rename = await read("src/app/api/drive/rename/route.ts");
  assert.match(rename, /isRegisteredPublicFolder\(body\.id\)/);

  // 상한 집행이 reserveUpload 계층에 있다 — 모든 업로드 경로가 자동 적용.
  const quota = await read("src/lib/storage-quota.ts");
  assert.match(quota, /findPublicFolderByFolderId\(input\.parentId\)/);

  // proxy 면제 목록 등재.
  const routing = await read("src/lib/space-routing.ts");
  assert.match(routing, /"\/api\/public-folder\/"/);
});

test("배선: 관리 API·화면 — admin 러너·identity 비노출·보상 롤백·탭", async () => {
  const read = (relative: string) =>
    readFile(new URL(`../${relative}`, import.meta.url), "utf8");

  const collection = await read("src/app/api/admin/public-folders/route.ts");
  assert.match(collection, /runWithAdmin\(\{ fresh: true \}/);
  assert.match(
    collection,
    /delete summary\.folderIdentity/,
    "관리 응답에 identity 비노출",
  );
  assert.match(
    collection,
    /adapter\.remove\(created\.id\)\.catch/,
    "등록 실패 시 폴더 보상 롤백",
  );
  assert.match(
    collection,
    /createFolder\(ROOT_ID, name\)/,
    "등록은 항상 루트에 새 폴더 — 평평 보장이 생성 시점부터 성립",
  );

  const item = await read("src/app/api/admin/public-folders/[id]/route.ts");
  assert.match(item, /runWithAdmin\(\{ fresh: true \}/);
  assert.match(item, /filesKept: true/, "해제는 파일을 데스크에 남긴다");

  const view = await read("src/app/admin/AdminView.tsx");
  assert.match(view, /tab-public/);
  assert.match(view, /<PublicFoldersPanel/);

  const panel = await read("src/app/admin/PublicFoldersPanel.tsx");
  assert.match(panel, /confirmRemove/, "등록 해제는 2단계 확인");
  assert.match(panel, /datetime-local/, "공개 시각은 로컬 입력 ↔ UTC ISO 변환");
  assert.match(
    panel,
    /\/api\/drive\/list\?folderId=/,
    "파일 목록은 기존 드라이브 API 재사용",
  );
});

test("배선: 사이드바 — 손잡이·공개 폴더 입장·추가기능 메뉴 대체 (#11)", async () => {
  const read = (relative: string) =>
    readFile(new URL(`../${relative}`, import.meta.url), "utf8");

  const view = await read("src/app/files/FilesView.tsx");
  assert.match(view, /styles\.sidebarHandle/);
  assert.match(view, /aria-controls="desk-sidebar"/);
  assert.match(view, /apiPath\("\/api\/public-folders"\)/);
  assert.match(view, /\{t\("공개 폴더 입장"\)\}/);
  assert.doesNotMatch(view, /extraFeatures/, "추가기능 메뉴는 사이드바로 대체");
  assert.doesNotMatch(view, /\{t\("추가기능"\)\}/);
  // 다운로드 우선은 작업표시줄 직접 체크박스로 남는다.
  assert.match(view, /checked=\{downloadFirst\}/);
  assert.match(view, /styles\.preferenceCheck/);
  // Escape·바깥 클릭 닫기 배선.
  assert.match(view, /sidebarHandleRef\.current\?\.contains\(target\)/);

  const route = await read("src/app/api/public-folders/route.ts");
  assert.match(route, /runWithSession\(\{ fresh: true \}/);
  assert.match(route, /space !== null/, "스페이스 문맥에서는 빈 목록");
  assert.match(
    route,
    /publicFolderAccess\(folder, session, now\) !== "open"/,
    "노출 판정은 공개 라우트와 같은 함수 하나",
  );
  assert.match(
    route,
    /target\.layoutKey !== folder\.folderIdentity/,
    "지워진 대상(죽은 링크)은 목록에서도 뺀다",
  );

  const css = await read("src/app/files/desktop.module.css");
  assert.match(css, /\.sidebarHandle \{/);
  assert.match(css, /\.sidebar \{/);
  assert.doesNotMatch(css, /extraFeaturesMenu/);
});
