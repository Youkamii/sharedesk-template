import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  applyRelease,
  applyBootstrapRelease,
  generateReleaseManifest,
  isProtectedPath,
  sha256,
  validateManifest,
} from "../scripts/sharedesk-update.mjs";
import {
  assertCleanGitRepository,
  bootstrapRelease,
} from "../scripts/sharedesk-bootstrap.mjs";
import {
  compareSemver,
  getUpdateStatus,
  resolveUpdateRepository,
  selectLatestStableVersion,
} from "../src/lib/update-status";

const execFileAsync = promisify(execFile);

function manifest(
  version: string,
  files: Record<string, string>,
  bootstrapFiles: Record<string, string> = {},
): {
  schemaVersion: number;
  version: string;
  files: Array<{
    path: string;
    sha256: string;
    acceptedSha256?: string[];
  }>;
  bootstrapFiles: Array<{
    path: string;
    sha256: string;
    acceptedSha256?: string[];
  }>;
} {
  return {
    schemaVersion: 1,
    version,
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      sha256: sha256(Buffer.from(content)),
    })),
    bootstrapFiles: Object.entries(bootstrapFiles).map(
      ([filePath, content]) => ({
        path: filePath,
        sha256: sha256(Buffer.from(content)),
      }),
    ),
  };
}

async function withTempDir(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "sharedesk-update-test-"));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("release manifest rejects traversal, absolute paths, and protected state", () => {
  for (const unsafePath of [
    "../outside.txt",
    "nested/../../outside.txt",
    "/absolute.txt",
    "C:/absolute.txt",
    "nested\\windows.txt",
    ".env",
    ".env.local",
    ".env.production",
    ".env.production/secret",
    ".git/config",
    ".vercel/project.json",
    ".sharedesk-updater/backup",
    ".github/workflows/sharedesk-update.yml",
    "sharedesk-release.json",
  ]) {
    assert.throws(
      () =>
        validateManifest({
          schemaVersion: 1,
          version: "1.0.0",
          files: [{ path: unsafePath, sha256: "a".repeat(64) }],
        }),
      /Unsafe managed path|Protected path/,
      unsafePath,
    );
  }
  assert.equal(isProtectedPath(".env"), true);
  assert.equal(isProtectedPath(".env.local"), true);
  assert.equal(isProtectedPath(".env.production"), true);
  assert.equal(isProtectedPath(".env.example"), false);
  assert.equal(isProtectedPath("scripts/sharedesk-update.mjs"), true);
  assert.equal(isProtectedPath("scripts/sharedesk-bootstrap.mjs"), true);
  assert.equal(isProtectedPath("src/app/page.tsx"), false);
});

test("manifest rejects bootstrap core duplicated in the managed file list", () => {
  const updater = "export {};\n";
  const updaterEntry = {
    path: "scripts/sharedesk-update.mjs",
    sha256: sha256(Buffer.from(updater)),
  };
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 1,
        version: "1.0.0",
        files: [updaterEntry],
        bootstrapFiles: [
          { path: "scripts/sharedesk-bootstrap.mjs", sha256: "a".repeat(64) },
          updaterEntry,
          {
            path: ".github/workflows/sharedesk-update.yml",
            sha256: "b".repeat(64),
          },
        ],
      }),
    /cannot also be managed/,
  );
});

test("manifest accepts known alternate line-ending hashes and rejects malformed alternates", () => {
  const lf = "first\nsecond\n";
  const crlf = "first\r\nsecond\r\n";
  const value = validateManifest({
    schemaVersion: 1,
    version: "1.0.0",
    files: [
      {
        path: "src/text.txt",
        sha256: sha256(Buffer.from(lf)),
        acceptedSha256: [sha256(Buffer.from(crlf))],
      },
    ],
  });
  assert.deepEqual(value.files[0].acceptedSha256, [sha256(Buffer.from(crlf))]);
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 1,
        version: "1.0.0",
        files: [
          {
            path: "src/text.txt",
            sha256: sha256(Buffer.from(lf)),
            acceptedSha256: ["not-a-hash"],
          },
        ],
      }),
    /Invalid acceptedSha256/,
  );
});

test("one-command bootstrap adds and changes core/app files, deletes only old managed files, and preserves local state", async () => {
  await withTempDir(async (rootDir) => {
    const updaterSource = await readFile(
      new URL("../scripts/sharedesk-update.mjs", import.meta.url),
      "utf8",
    );
    const bootstrapSource = await readFile(
      new URL("../scripts/sharedesk-bootstrap.mjs", import.meta.url),
      "utf8",
    );
    const core = {
      "scripts/sharedesk-bootstrap.mjs": bootstrapSource,
      "scripts/sharedesk-update.mjs": updaterSource,
      ".github/workflows/sharedesk-update.yml": "name: current updater\n",
    };
    const previous = manifest("1.0.0", {
      "src/change.txt": "old",
      "src/delete.txt": "old release file",
    });
    const nextFiles = {
      "src/change.txt": "new",
      "src/add.txt": "new release file",
    };
    const next = manifest("1.1.0", nextFiles, core);
    await mkdir(path.join(rootDir, "src"));
    await mkdir(path.join(rootDir, ".vercel"));
    await writeFile(path.join(rootDir, "src/change.txt"), "old");
    await writeFile(path.join(rootDir, "src/delete.txt"), "old release file");
    await writeFile(path.join(rootDir, "src/local.txt"), "preserve");
    await writeFile(path.join(rootDir, ".env.local"), "SECRET=preserve");
    await writeFile(path.join(rootDir, ".vercel/project.json"), "preserve");
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    const allContents: Record<string, string> = { ...nextFiles, ...core };

    const result = await bootstrapRelease({
      rootDir,
      manifest: next,
      assertClean: async () => undefined,
      fetchFile: async (filePath: string) => Buffer.from(allContents[filePath]),
    });

    assert.equal(result.changed, true);
    assert.equal(await readFile(path.join(rootDir, "src/change.txt"), "utf8"), "new");
    assert.equal(await readFile(path.join(rootDir, "src/add.txt"), "utf8"), "new release file");
    await assert.rejects(readFile(path.join(rootDir, "src/delete.txt")), /ENOENT/);
    assert.equal(await readFile(path.join(rootDir, "src/local.txt"), "utf8"), "preserve");
    assert.equal(await readFile(path.join(rootDir, ".env.local"), "utf8"), "SECRET=preserve");
    assert.equal(await readFile(path.join(rootDir, ".vercel/project.json"), "utf8"), "preserve");
    assert.equal(
      await readFile(path.join(rootDir, ".github/workflows/sharedesk-update.yml"), "utf8"),
      "name: current updater\n",
    );
    assert.equal(
      sha256(await readFile(path.join(rootDir, "scripts/sharedesk-update.mjs"))),
      sha256(Buffer.from(updaterSource)),
    );
  });
});

test("bootstrap uses a matching legacy baseline and rejects committed customizations", async () => {
  const updaterSource = await readFile(
    new URL("../scripts/sharedesk-update.mjs", import.meta.url),
    "utf8",
  );
  const bootstrapSource = await readFile(
    new URL("../scripts/sharedesk-bootstrap.mjs", import.meta.url),
    "utf8",
  );
  const core = {
    "scripts/sharedesk-bootstrap.mjs": bootstrapSource,
    "scripts/sharedesk-update.mjs": updaterSource,
    ".github/workflows/sharedesk-update.yml": "name: updater\n",
  };
  const oldPackage = '{"version":"1.0.0"}\n';
  const newPackage = '{"version":"1.1.0"}\n';
  const legacy = manifest("1.0.0", {
    "package.json": oldPackage,
    "src/legacy.txt": "known old content",
  });
  const nextFiles = {
    "package.json": newPackage,
    "src/current.txt": "current content",
  };
  const next = {
    ...manifest("1.1.0", nextFiles, core),
    legacyManifests: [legacy],
  };
  const allContents: Record<string, string> = { ...nextFiles, ...core };

  await withTempDir(async (rootDir) => {
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "package.json"), oldPackage);
    await writeFile(path.join(rootDir, "src/legacy.txt"), "known old content");
    const result = await bootstrapRelease({
      rootDir,
      manifest: next,
      assertClean: async () => undefined,
      fetchFile: async (filePath: string) => Buffer.from(allContents[filePath]),
    });
    assert.equal(result.changed, true);
    assert.equal(await readFile(path.join(rootDir, "package.json"), "utf8"), newPackage);
    assert.equal(
      await readFile(path.join(rootDir, "src/current.txt"), "utf8"),
      "current content",
    );
    await assert.rejects(readFile(path.join(rootDir, "src/legacy.txt")), /ENOENT/);
  });

  await withTempDir(async (rootDir) => {
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "package.json"), oldPackage);
    await writeFile(path.join(rootDir, "src/legacy.txt"), "committed customization");
    await assert.rejects(
      bootstrapRelease({
        rootDir,
        manifest: next,
        assertClean: async () => undefined,
        fetchFile: async (filePath: string) => Buffer.from(allContents[filePath]),
      }),
      /src\/legacy\.txt/,
    );
    assert.equal(
      await readFile(path.join(rootDir, "src/legacy.txt"), "utf8"),
      "committed customization",
    );
    assert.equal(await readFile(path.join(rootDir, "package.json"), "utf8"), oldPackage);
    await assert.rejects(
      readFile(path.join(rootDir, "sharedesk-release.json")),
      /ENOENT/,
    );
  });
});

test("subsequent updates replace bootstrap core and detect local core changes", async () => {
  const oldCore = {
    "scripts/sharedesk-bootstrap.mjs": "old bootstrap\n",
    "scripts/sharedesk-update.mjs": "old updater\n",
    ".github/workflows/sharedesk-update.yml": "name: old workflow\n",
  };
  const newCore = {
    "scripts/sharedesk-bootstrap.mjs": "new bootstrap\n",
    "scripts/sharedesk-update.mjs": "new updater\n",
    ".github/workflows/sharedesk-update.yml": "name: new workflow\n",
  };
  const previous = manifest("1.0.0", { "src/app.txt": "old app\n" }, oldCore);
  const nextFiles = { "src/app.txt": "new app\n" };
  const next = manifest("1.1.0", nextFiles, newCore);
  const allContents: Record<string, string> = { ...nextFiles, ...newCore };

  await withTempDir(async (rootDir) => {
    for (const [filePath, content] of Object.entries({
      "src/app.txt": "old app\n",
      ...oldCore,
    })) {
      await mkdir(path.dirname(path.join(rootDir, ...filePath.split("/"))), {
        recursive: true,
      });
      await writeFile(path.join(rootDir, ...filePath.split("/")), content);
    }
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    const result = await applyBootstrapRelease({
      rootDir,
      manifest: next,
      fetchFile: async (filePath: string) => Buffer.from(allContents[filePath]),
    });
    assert.equal(result.changed, true);
    for (const [filePath, content] of Object.entries(newCore)) {
      assert.equal(
        await readFile(path.join(rootDir, ...filePath.split("/")), "utf8"),
        content,
      );
    }
  });

  await withTempDir(async (rootDir) => {
    for (const [filePath, content] of Object.entries({
      "src/app.txt": "old app\n",
      ...oldCore,
    })) {
      await mkdir(path.dirname(path.join(rootDir, ...filePath.split("/"))), {
        recursive: true,
      });
      await writeFile(path.join(rootDir, ...filePath.split("/")), content);
    }
    await writeFile(
      path.join(rootDir, "scripts/sharedesk-update.mjs"),
      "locally customized updater\n",
    );
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    await assert.rejects(
      applyBootstrapRelease({
        rootDir,
        manifest: next,
        fetchFile: async (filePath: string) => Buffer.from(allContents[filePath]),
      }),
      /scripts\/sharedesk-update\.mjs/,
    );
    assert.equal(
      await readFile(path.join(rootDir, "src/app.txt"), "utf8"),
      "old app\n",
    );
    assert.equal(
      await readFile(path.join(rootDir, "scripts/sharedesk-update.mjs"), "utf8"),
      "locally customized updater\n",
    );
  });
});

test("bootstrap refuses a dirty Git repository before changing files", async () => {
  await withTempDir(async (rootDir) => {
    await execFileAsync("git", ["init"], { cwd: rootDir, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.name", "ShareDesk Test"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await writeFile(path.join(rootDir, "tracked.txt"), "clean");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: rootDir, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "initial"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await assertCleanGitRepository(rootDir);

    await writeFile(path.join(rootDir, "tracked.txt"), "dirty");
    await assert.rejects(assertCleanGitRepository(rootDir), /local changes/);

    let fetched = false;
    await assert.rejects(
      bootstrapRelease({
        rootDir,
        manifest: {},
        fetchFile: async () => {
          fetched = true;
          return Buffer.alloc(0);
        },
      }),
      /local changes/,
    );
    assert.equal(fetched, false);
    assert.equal(await readFile(path.join(rootDir, "tracked.txt"), "utf8"), "dirty");
  });
});

test("manifest generator captures the current snapshot, bootstrap core, legacy deletions, and CRLF alternates", async () => {
  await withTempDir(async (rootDir) => {
    await execFileAsync("git", ["init"], { cwd: rootDir, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.name", "ShareDesk Test"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await mkdir(path.join(rootDir, "src"));
    await writeFile(
      path.join(rootDir, "package.json"),
      '{"name":"sharedesk","version":"1.0.0"}\n',
    );
    await writeFile(path.join(rootDir, "src/legacy.txt"), "legacy\n");
    await execFileAsync("git", ["add", "package.json", "src/legacy.txt"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await execFileAsync("git", ["commit", "-m", "legacy"], {
      cwd: rootDir,
      windowsHide: true,
    });
    const legacyRef = (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: rootDir,
        encoding: "utf8",
        windowsHide: true,
      })
    ).stdout.trim();

    await execFileAsync("git", ["rm", "src/legacy.txt"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await mkdir(path.join(rootDir, "src"));
    await mkdir(path.join(rootDir, "scripts"));
    await mkdir(path.join(rootDir, ".github/workflows"), { recursive: true });
    await mkdir(path.join(rootDir, ".vercel"));
    await writeFile(
      path.join(rootDir, "package.json"),
      '{"name":"sharedesk","version":"1.1.0"}\r\n',
    );
    await writeFile(path.join(rootDir, "src/current.txt"), "current\r\n");
    await writeFile(
      path.join(rootDir, "scripts/sharedesk-bootstrap.mjs"),
      "export {};\r\n",
    );
    await writeFile(
      path.join(rootDir, "scripts/sharedesk-update.mjs"),
      "export {};\r\n",
    );
    await writeFile(
      path.join(rootDir, ".github/workflows/sharedesk-update.yml"),
      "on:\r\n  workflow_dispatch:\r\n",
    );
    await writeFile(path.join(rootDir, ".env.local"), "SECRET=preserve");
    await writeFile(path.join(rootDir, ".vercel/project.json"), "preserve");
    await execFileAsync("git", ["add", "-A"], { cwd: rootDir, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "current"], {
      cwd: rootDir,
      windowsHide: true,
    });

    const generated = await generateReleaseManifest({ rootDir, legacyRef });
    assert.equal(generated.version, "1.1.0");
    assert.equal(generated.files.some((entry) => entry.path === "src/current.txt"), true);
    assert.equal(generated.files.some((entry) => entry.path === "src/legacy.txt"), false);
    assert.equal(generated.files.some((entry) => entry.path === ".env.local"), false);
    assert.equal(generated.files.some((entry) => entry.path.startsWith(".vercel/")), false);
    assert.equal(
      generated.bootstrapFiles.some(
        (entry) => entry.path === ".github/workflows/sharedesk-update.yml",
      ),
      true,
    );
    assert.equal(generated.legacyManifests[0].version, "1.0.0");
    assert.equal(
      generated.legacyManifests[0].files.some(
        (entry: { path: string }) => entry.path === "src/legacy.txt",
      ),
      true,
    );
    assert.ok(
      generated.files.find((entry) => entry.path === "src/current.txt")
        ?.acceptedSha256?.length,
    );
  });
});

test("hash failure leaves the installed tree unchanged", async () => {
  await withTempDir(async (rootDir) => {
    const previous = manifest("1.0.0", { "src/current.txt": "current" });
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src/current.txt"), "current");
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    const beforeManifest = await readFile(
      path.join(rootDir, "sharedesk-release.json"),
      "utf8",
    );
    const next = manifest("1.1.0", {
      "src/current.txt": "changed",
      "src/new.txt": "new",
    });

    await assert.rejects(
      applyRelease({
        rootDir,
        manifest: next,
        fetchFile: async (filePath: string) =>
          Buffer.from(filePath === "src/new.txt" ? "tampered" : "changed"),
      }),
      /Hash verification failed/,
    );
    assert.equal(await readFile(path.join(rootDir, "src/current.txt"), "utf8"), "current");
    await assert.rejects(readFile(path.join(rootDir, "src/new.txt")), /ENOENT/);
    assert.equal(
      await readFile(path.join(rootDir, "sharedesk-release.json"), "utf8"),
      beforeManifest,
    );
  });
});

test("the public environment example is managed while real environment files stay untouched", async () => {
  await withTempDir(async (rootDir) => {
    const previous = manifest("1.0.0", { ".env.example": "OLD=value\n" });
    const next = manifest("1.1.0", { ".env.example": "NEW=value\n" });
    await writeFile(path.join(rootDir, ".env.example"), "OLD=value\n");
    await writeFile(path.join(rootDir, ".env.local"), "SECRET=preserve\n");
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    await applyRelease({
      rootDir,
      manifest: next,
      fetchFile: async () => Buffer.from("NEW=value\n"),
    });
    assert.equal(
      await readFile(path.join(rootDir, ".env.example"), "utf8"),
      "NEW=value\n",
    );
    assert.equal(
      await readFile(path.join(rootDir, ".env.local"), "utf8"),
      "SECRET=preserve\n",
    );
  });
});

test("preflight rejects changed old files, occupied new paths, and changed removals before applying anything", async () => {
  const cases = [
    {
      name: "changed managed file",
      existing: {
        "src/change.txt": "local customization",
        "src/delete.txt": "delete me",
      },
      conflict: "src/change.txt",
    },
    {
      name: "occupied new path",
      existing: {
        "src/change.txt": "old",
        "src/delete.txt": "delete me",
        "src/add.txt": "user file",
      },
      conflict: "src/add.txt",
    },
    {
      name: "changed removal",
      existing: {
        "src/change.txt": "old",
        "src/delete.txt": "keep my customization",
      },
      conflict: "src/delete.txt",
    },
  ];

  for (const scenario of cases) {
    await withTempDir(async (rootDir) => {
      const previous = manifest("1.0.0", {
        "src/change.txt": "old",
        "src/delete.txt": "delete me",
      });
      const nextContents = {
        "src/change.txt": "new",
        "src/add.txt": "added",
      };
      const next = manifest("1.1.0", nextContents);
      await mkdir(path.join(rootDir, "src"));
      for (const [filePath, content] of Object.entries(scenario.existing)) {
        await writeFile(path.join(rootDir, ...filePath.split("/")), content);
      }
      const previousManifest = `${JSON.stringify(previous, null, 2)}\n`;
      await writeFile(
        path.join(rootDir, "sharedesk-release.json"),
        previousManifest,
      );

      await assert.rejects(
        applyRelease({
          rootDir,
          manifest: next,
          fetchFile: async (filePath: keyof typeof nextContents) =>
            Buffer.from(nextContents[filePath]),
        }),
        new RegExp(scenario.conflict.replace(".", "\\.")),
        scenario.name,
      );
      for (const [filePath, content] of Object.entries(scenario.existing)) {
        assert.equal(
          await readFile(path.join(rootDir, ...filePath.split("/")), "utf8"),
          content,
          `${scenario.name}: ${filePath}`,
        );
      }
      assert.equal(
        await readFile(path.join(rootDir, "sharedesk-release.json"), "utf8"),
        previousManifest,
      );
      if (!("src/add.txt" in scenario.existing)) {
        await assert.rejects(readFile(path.join(rootDir, "src/add.txt")), /ENOENT/);
      }
    });
  }
});

test("preflight treats a declared CRLF hash as the same managed text file", async () => {
  await withTempDir(async (rootDir) => {
    const lf = "old\ntext\n";
    const crlf = "old\r\ntext\r\n";
    const nextText = "new\ntext\n";
    const previous = manifest("1.0.0", { "src/text.txt": lf });
    previous.files[0].acceptedSha256 = [sha256(Buffer.from(crlf))];
    const next = manifest("1.1.0", { "src/text.txt": nextText });
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src/text.txt"), crlf);
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );

    const result = await applyRelease({
      rootDir,
      manifest: next,
      fetchFile: async () => Buffer.from(nextText),
    });
    assert.equal(result.changed, true);
    assert.equal(await readFile(path.join(rootDir, "src/text.txt"), "utf8"), nextText);
  });
});

test("apply adds, changes, and removes only manifest-managed files and is idempotent", async () => {
  await withTempDir(async (rootDir) => {
    const previous = manifest("1.0.0", {
      "src/change.txt": "old",
      "src/delete.txt": "delete me",
    });
    await mkdir(path.join(rootDir, "src"));
    await mkdir(path.join(rootDir, ".vercel"));
    await writeFile(path.join(rootDir, "src/change.txt"), "old");
    await writeFile(path.join(rootDir, "src/delete.txt"), "delete me");
    await writeFile(path.join(rootDir, "src/unmanaged.txt"), "keep me");
    await writeFile(path.join(rootDir, ".env.local"), "SECRET=keep");
    await writeFile(path.join(rootDir, ".vercel/project.json"), "keep");
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );

    const contents = {
      "src/change.txt": "new",
      "src/add.txt": "added",
    };
    const next = manifest("1.1.0", contents);
    const fetchFile = async (filePath: keyof typeof contents) =>
      Buffer.from(contents[filePath]);
    const first = await applyRelease({ rootDir, manifest: next, fetchFile });

    assert.equal(first.changed, true);
    assert.deepEqual(first.written.sort(), ["src/add.txt", "src/change.txt"]);
    assert.deepEqual(first.removed, ["src/delete.txt"]);
    assert.equal(await readFile(path.join(rootDir, "src/change.txt"), "utf8"), "new");
    assert.equal(await readFile(path.join(rootDir, "src/add.txt"), "utf8"), "added");
    await assert.rejects(readFile(path.join(rootDir, "src/delete.txt")), /ENOENT/);
    assert.equal(await readFile(path.join(rootDir, "src/unmanaged.txt"), "utf8"), "keep me");
    assert.equal(await readFile(path.join(rootDir, ".env.local"), "utf8"), "SECRET=keep");
    assert.equal(await readFile(path.join(rootDir, ".vercel/project.json"), "utf8"), "keep");

    const second = await applyRelease({ rootDir, manifest: next, fetchFile });
    assert.deepEqual(second, {
      changed: false,
      version: "1.1.0",
      written: [],
      removed: [],
    });
  });
});

test("apply rejects a managed path that crosses a symbolic link", async (t) => {
  await withTempDir(async (rootDir) => {
    const outside = await mkdtemp(path.join(tmpdir(), "sharedesk-update-outside-"));
    try {
      try {
        await symlink(outside, path.join(rootDir, "linked"),
          process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("Creating a test symlink is not permitted on this system.");
          return;
        }
        throw error;
      }
      const next = manifest("1.0.0", { "linked/escape.txt": "blocked" });
      await assert.rejects(
        applyRelease({
          rootDir,
          manifest: next,
          fetchFile: async () => Buffer.from("blocked"),
        }),
        /Symbolic links are not allowed/,
      );
      await assert.rejects(readFile(path.join(outside, "escape.txt")), /ENOENT/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("repository resolution is strict and explicit configuration takes precedence", () => {
  assert.deepEqual(
    resolveUpdateRepository({
      SHAREDESK_GITHUB_REPOSITORY: "owner/installed-repo",
      VERCEL_GIT_REPO_OWNER: "vercel-owner",
      VERCEL_GIT_REPO_SLUG: "vercel-repo",
    }),
    { repository: "owner/installed-repo", configured: true },
  );
  assert.deepEqual(
    resolveUpdateRepository({
      VERCEL_GIT_REPO_OWNER: "vercel-owner",
      VERCEL_GIT_REPO_SLUG: "vercel-repo",
    }),
    { repository: "vercel-owner/vercel-repo", configured: true },
  );
  for (const repository of [
    "owner/repo/extra",
    " owner/repo",
    "owner/../repo",
    "owner/repo name",
    "-owner/repo",
  ]) {
    const result = resolveUpdateRepository({
      SHAREDESK_GITHUB_REPOSITORY: repository,
      VERCEL_GIT_REPO_OWNER: "fallback",
      VERCEL_GIT_REPO_SLUG: "must-not-be-used",
    });
    assert.equal(result.configured, false, repository);
    assert.equal(result.repository, null, repository);
  }
});

test("stable release selection and semantic version comparison ignore drafts and prereleases", () => {
  assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
  assert.equal(compareSemver("v2.0.0", "2.0.0"), 0);
  assert.equal(compareSemver("2.0.0-rc.1", "2.0.0"), -1);
  assert.equal(
    selectLatestStableVersion([
      { tag_name: "v9.0.0", draft: true, prerelease: false },
      { tag_name: "v8.0.0", draft: false, prerelease: true },
      { tag_name: "v7.0.0-rc.1", draft: false, prerelease: false },
      { tag_name: "v1.9.0", draft: false, prerelease: false },
      { tag_name: "v1.10.0", draft: false, prerelease: false },
    ]),
    "1.10.0",
  );
});

test("update status reports the installed workflow and handles GitHub errors", async () => {
  const status = await getUpdateStatus({
    currentVersion: "1.0.0",
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl: async () =>
      Response.json([
        { tag_name: "v1.1.0", draft: false, prerelease: false },
      ]),
  });
  assert.deepEqual(status, {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateAvailable: true,
    repository: "acme/sharedesk",
    workflowUrl:
      "https://github.com/acme/sharedesk/actions/workflows/sharedesk-update.yml",
    configured: true,
  });

  const failed = await getUpdateStatus({
    currentVersion: "1.0.0",
    env: {},
    fetchImpl: async () => new Response("no", { status: 503 }),
  });
  assert.equal(failed.latestVersion, null);
  assert.equal(failed.updateAvailable, false);
  assert.equal(failed.configured, false);
  assert.equal(failed.repository, null);
  assert.equal(failed.workflowUrl, null);
  assert.match(failed.error ?? "", /503/);
});

test("manual update workflow is pinned, main-only, and validates before push", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/sharedesk-update.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^on:\r?\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /\bschedule\s*:/);
  assert.doesNotMatch(workflow, /\bcron\s*:/);
  assert.match(workflow, /^permissions:\r?\n  contents: write$/m);
  assert.match(
    workflow,
    /uses: actions\/checkout@[a-f0-9]{40} # v\d+(?:\.\d+){0,2}/,
  );
  assert.match(
    workflow,
    /uses: actions\/setup-node@[a-f0-9]{40} # v\d+(?:\.\d+){0,2}/,
  );
  assert.match(workflow, /^          ref: main$/m);
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.doesNotMatch(workflow, /secrets\./);

  const orderedSteps = [
    "node scripts/sharedesk-update.mjs --apply",
    "npm ci",
    "npm test",
    "npm run lint",
    "npx tsc --noEmit",
    "npm run build",
    "git commit",
    "git push origin HEAD:main",
  ];
  let previousIndex = -1;
  for (const step of orderedSteps) {
    const currentIndex = workflow.indexOf(step);
    assert.ok(currentIndex > previousIndex, `${step} must appear in order`);
    previousIndex = currentIndex;
  }
});
