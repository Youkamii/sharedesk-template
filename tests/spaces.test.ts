import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_SPACES,
  parseSpaceName,
  parseSpaceSlug,
  RESERVED_SLUGS,
} from "../src/lib/spaces";

test("스페이스 슬러그는 소문자 영숫자·하이픈 1~32자만 받는다", () => {
  for (const [input, expected] of [
    ["a", "a"],
    ["sea", "sea"],
    ["my-desk", "my-desk"],
    ["a1b2", "a1b2"],
    ["x".repeat(32), "x".repeat(32)],
    // 사용자는 /A/files 처럼 대문자로도 적는다 — 같은 스페이스로 접는다.
    ["A", "a"],
    ["Sea", "sea"],
    ["  sea  ", "sea"],
  ] as const) {
    assert.equal(parseSpaceSlug(input), expected, `허용돼야 함: ${input}`);
  }
  for (const input of [
    "",
    "   ",
    "-lead",
    "trail-",
    "x".repeat(33),
    "한글",
    "a b",
    "a_b",
    "a.b",
    "a/b",
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseSpaceSlug(input), null, `거부돼야 함: ${String(input)}`);
  }
});

test("예약어는 슬러그로 쓸 수 없다", () => {
  for (const reserved of ["api", "files", "admin", "join", "pending", "_next"]) {
    assert.equal(parseSpaceSlug(reserved), null, `거부돼야 함: ${reserved}`);
    assert.equal(
      parseSpaceSlug(reserved.toUpperCase()),
      null,
      `대문자도 거부돼야 함: ${reserved}`,
    );
  }
});

// 새 최상위 라우트나 공개 자산이 생겼는데 예약어에 안 넣으면, 그 이름의
// 스페이스가 앱 화면을 가린다. 실물 디렉터리와 대조해 드리프트를 막는다.
test("예약어 목록은 실제 최상위 라우트·공개 자산을 전부 담는다", async () => {
  const appEntries = await readdir(new URL("../src/app", import.meta.url), {
    withFileTypes: true,
  });
  for (const entry of appEntries) {
    if (!entry.isDirectory()) continue;
    assert.ok(
      RESERVED_SLUGS.has(entry.name),
      `src/app/${entry.name} 이 예약어에 없다 — RESERVED_SLUGS에 추가하라`,
    );
  }
  const publicEntries = await readdir(new URL("../public", import.meta.url), {
    withFileTypes: true,
  });
  for (const entry of publicEntries) {
    if (!entry.isDirectory()) continue;
    assert.ok(
      RESERVED_SLUGS.has(entry.name),
      `public/${entry.name} 이 예약어에 없다 — RESERVED_SLUGS에 추가하라`,
    );
  }
});

test("스페이스 이름은 trim 후 1~40자, 제어문자 불가", () => {
  assert.equal(parseSpaceName("  우리 팀  "), "우리 팀");
  assert.equal(parseSpaceName("x".repeat(40)), "x".repeat(40));
  for (const input of ["", "   ", "x".repeat(41), "a\u0000b", "a\u001fb", 42, null]) {
    assert.equal(parseSpaceName(input), null, `거부돼야 함: ${String(input)}`);
  }
});

// 등록부 CRUD는 실제 로컬 저장소로 왕복한다. 환경변수를 세운 뒤 동적 import.
async function withRegistry(
  run: (spaces: typeof import("../src/lib/spaces")) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-spaces-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    await run(await import("../src/lib/spaces"));
  } finally {
    process.env.STORAGE_DRIVER = previousDriver;
    process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

test("스페이스 등록·조회·이름 변경·삭제가 왕복한다", async () => {
  await withRegistry(async (spaces) => {
    assert.deepEqual(await spaces.listSpaces(), []);

    const created = await spaces.addSpace({
      slug: "Sea",
      name: "바다 데스크",
      folderId: null,
      createdByUserId: "user-1",
    });
    assert.equal(created.slug, "sea");
    assert.equal(created.folderId, null);

    await spaces.addSpace({
      slug: "team",
      name: "팀",
      folderId: "folder-123",
      createdByUserId: "user-1",
    });

    const listed = await spaces.listSpaces();
    assert.deepEqual(listed.map((space) => space.slug).sort(), ["sea", "team"]);

    // 대문자 조회도 같은 스페이스다.
    const found = await spaces.getSpace("SEA");
    assert.equal(found?.name, "바다 데스크");

    const renamed = await spaces.renameSpace("sea", "새 이름");
    assert.equal(renamed?.name, "새 이름");
    assert.equal((await spaces.getSpace("sea"))?.name, "새 이름");

    assert.equal(await spaces.removeSpace("sea"), true);
    assert.equal(await spaces.removeSpace("sea"), false);
    assert.equal(await spaces.getSpace("sea"), null);
  });
});

test("같은 슬러그는 두 번 등록되지 않는다", async () => {
  await withRegistry(async (spaces) => {
    await spaces.addSpace({
      slug: "sea",
      name: "하나",
      folderId: null,
      createdByUserId: "u",
    });
    await assert.rejects(
      spaces.addSpace({
        slug: "SEA",
        name: "둘",
        folderId: "f",
        createdByUserId: "u",
      }),
      /이미 있는 스페이스 주소/,
    );
  });
});

test("예약어·잘못된 입력으로는 등록되지 않는다", async () => {
  await withRegistry(async (spaces) => {
    for (const slug of ["api", "-x", ""]) {
      await assert.rejects(
        spaces.addSpace({ slug, name: "이름", folderId: null, createdByUserId: "u" }),
        /스페이스 주소가 올바르지 않습니다/,
      );
    }
    await assert.rejects(
      spaces.addSpace({ slug: "ok", name: "  ", folderId: null, createdByUserId: "u" }),
      /스페이스 이름이 올바르지 않습니다/,
    );
  });
});

test("스페이스 수 상한을 넘기면 거부한다", async () => {
  await withRegistry(async (spaces) => {
    for (let index = 0; index < MAX_SPACES; index += 1) {
      await spaces.addSpace({
        slug: `s${index}`,
        name: `스페이스 ${index}`,
        folderId: `f${index}`,
        createdByUserId: "u",
      });
    }
    await assert.rejects(
      spaces.addSpace({ slug: "one-more", name: "초과", folderId: "f", createdByUserId: "u" }),
      /스페이스가 너무 많습니다/,
    );
  });
});

test("망가진 등록부 항목은 조용히 버려지고 나머지는 산다", async () => {
  await withRegistry(async (spaces) => {
    const { getAdapter } = await import("../src/lib/storage");
    await getAdapter().writeState("spaces.json", {
      version: 1,
      spaces: [
        {
          slug: "good",
          name: "정상",
          folderId: null,
          createdAt: new Date().toISOString(),
          createdByUserId: "u",
        },
        // 예약어 — 손으로 파일을 고쳐도 살아나면 안 된다.
        {
          slug: "api",
          name: "가림",
          folderId: null,
          createdAt: new Date().toISOString(),
          createdByUserId: "u",
        },
        { slug: "broken" },
        "garbage",
        { slug: "good", name: "중복", folderId: null, createdAt: new Date().toISOString(), createdByUserId: "u" },
      ],
    });
    const listed = await spaces.listSpaces();
    assert.deepEqual(listed.map((space) => space.slug), ["good"]);
    assert.equal(listed[0].name, "정상");
  });
});
