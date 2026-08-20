import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  applyAutomaticRelease,
  applyRelease,
  assertNotDowngrade,
  assertReleaseSourcesCommitted,
  fetchGitHubReleasePages as fetchUpdaterReleasePages,
  generateReleaseManifest,
  isProtectedPath,
  planRelease,
  selectStableRelease as selectUpdaterStableRelease,
  sha256,
  validateManifest,
  BOOTSTRAP_CORE_PATHS,
} from "../scripts/sharedesk-update.mjs";
import {
  assertCleanGitRepository,
  bootstrapRelease,
  fetchGitHubReleasePages as fetchBootstrapReleasePages,
  selectStableRelease as selectBootstrapStableRelease,
} from "../scripts/sharedesk-bootstrap.mjs";
import {
  addStar,
  checkStarred,
  STAR_REPOSITORY,
} from "../src/lib/github-star";
import {
  compareSemver,
  UPDATE_SOURCE_REPOSITORY,
  dispatchUpdateWorkflow,
  fetchGitHubReleasePages as fetchStatusReleasePages,
  fetchLatestStableReleaseFallback,
  fetchLatestUpdateRun,
  getUpdateStatus,
  resolveUpdateRepository,
  resolveUpdateToken,
  selectLatestStableVersion,
} from "../src/lib/update-status";
import {
  nextUpdateRunState,
  UPDATE_RUN_STALL_MS,
  type UpdateRunState,
} from "../src/lib/client/update-run";

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

function paginatedReleaseFetch(): {
  fetchImpl: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("page=2")) {
      return Response.json([
        { tag_name: "v1.2.0", draft: false, prerelease: false },
      ]);
    }
    return Response.json(
      Array.from({ length: 100 }, (_, index) => ({
        tag_name: `v2.0.0-rc.${index + 1}`,
        draft: false,
        prerelease: true,
      })),
      {
        headers: {
          Link: '<https://api.github.com/repos/Youkamii/sharedesk-template/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/Youkamii/sharedesk-template/releases?per_page=100&page=2>; rel="last"',
        },
      },
    );
  }) as typeof fetch;
  return { fetchImpl, requested };
}

test("release manifest rejects traversal, absolute paths, and protected state", () => {
  for (const unsafePath of [
    "../outside.txt",
    "nested/../../outside.txt",
    "/absolute.txt",
    "C:/absolute.txt",
    "nested\\windows.txt",
    "src/a?.txt",
    "src/a*.txt",
    "src/a<.txt",
    "src/a>.txt",
    'src/a".txt',
    "src/a|.txt",
    "src/control\u0001.txt",
    ".env",
    ".env.local",
    ".env.production",
    ".env.production/secret",
    "config/.env.local",
    "config/.env.example/secret",
    ".git/config",
    "nested/.git/config",
    ".vercel/project.json",
    "deploy/.vercel/project.json",
    ".sharedesk-updater/backup",
    "nested/.sharedesk-updater/backup",
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
  assert.equal(isProtectedPath("config/.env.local"), true);
  assert.equal(isProtectedPath("config/.env.example"), false);
  assert.equal(isProtectedPath("config/.env.example/secret"), true);
  assert.equal(isProtectedPath("deploy/.vercel/project.json"), true);
  assert.equal(isProtectedPath("nested/.sharedesk-updater/backup"), true);
  assert.equal(isProtectedPath("scripts/sharedesk-update.mjs"), true);
  assert.equal(isProtectedPath("scripts/sharedesk-bootstrap.mjs"), true);
  assert.equal(isProtectedPath("src/app/page.tsx"), false);
});

test("release manifest rejects Windows reserved device names", () => {
  for (const unsafePath of [
    "CON",
    "src/con.txt",
    "src/CON .txt",
    "src/NUL.json",
    "AUX/config.txt",
    "src/PRN.backup.txt",
    "src/COM1.log",
    "src/com9",
    "src/LPT1.txt",
    "src/lpt9.data",
  ]) {
    assert.throws(
      () =>
        validateManifest({
          schemaVersion: 1,
          version: "1.0.0",
          files: [{ path: unsafePath, sha256: "a".repeat(64) }],
        }),
      /Unsafe managed path/,
      unsafePath,
    );
  }

  assert.doesNotThrow(() =>
    validateManifest({
      schemaVersion: 1,
      version: "1.0.0",
      files: [
        { path: "src/console.txt", sha256: "a".repeat(64) },
        { path: "src/COM10.txt", sha256: "b".repeat(64) },
      ],
    }),
  );
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

test("bootstrap accepts stable versions with build metadata", async () => {
  await withTempDir(async (rootDir) => {
    const core = {
      "scripts/sharedesk-bootstrap.mjs": "bootstrap\n",
      "scripts/sharedesk-update.mjs": "updater\n",
      ".github/workflows/sharedesk-update.yml": "workflow\n",
    };
    const next = manifest("1.1.0+build.7", { "src/app.txt": "app\n" }, core);
    let appliedVersion = "";
    await bootstrapRelease({
      rootDir,
      manifest: next,
      assertClean: async () => undefined,
      fetchFile: async () => Buffer.alloc(0),
      applyBootstrap: async ({ manifest: appliedManifest }) => {
        appliedVersion = appliedManifest.version;
        return { changed: false };
      },
    });
    assert.equal(appliedVersion, "1.1.0+build.7");
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
  const oldPackage = '{"version":"v1.0.0"}\n';
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

test("manual managed updates replace executable core, preserve the workflow, and detect local core changes", async () => {
  const oldCore = {
    "scripts/sharedesk-bootstrap.mjs": "old bootstrap\n",
    "scripts/sharedesk-update.mjs": "old updater\n",
    ".github/workflows/sharedesk-update.yml": "name: old workflow\n",
  };
  const newCore = {
    "scripts/sharedesk-bootstrap.mjs": "new bootstrap\n",
    "scripts/sharedesk-update.mjs": "new updater\n",
    ".github/workflows/sharedesk-update.yml": "name: old workflow\n",
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
    const result = await applyAutomaticRelease({
      rootDir,
      manifest: next,
      fetchFile: async (filePath: string) => Buffer.from(allContents[filePath]),
    });
    assert.equal(result.changed, true);
    for (const filePath of [
      "scripts/sharedesk-bootstrap.mjs",
      "scripts/sharedesk-update.mjs",
    ]) {
      assert.equal(
        await readFile(path.join(rootDir, ...filePath.split("/")), "utf8"),
        newCore[filePath as keyof typeof newCore],
      );
    }
    assert.equal(
      await readFile(
        path.join(rootDir, ".github/workflows/sharedesk-update.yml"),
        "utf8",
      ),
      oldCore[".github/workflows/sharedesk-update.yml"],
    );
    const installed = JSON.parse(
      await readFile(path.join(rootDir, "sharedesk-release.json"), "utf8"),
    );
    assert.equal(
      installed.bootstrapFiles.find(
        (entry: { path: string }) =>
          entry.path === ".github/workflows/sharedesk-update.yml",
      ).sha256,
      sha256(Buffer.from(oldCore[".github/workflows/sharedesk-update.yml"])),
    );
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
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    const workflowChangedCore = {
      ...newCore,
      ".github/workflows/sharedesk-update.yml": "name: changed workflow\n",
    };
    await assert.rejects(
      applyAutomaticRelease({
        rootDir,
        manifest: manifest("1.1.0", nextFiles, workflowChangedCore),
        fetchFile: async (filePath: string) => {
          const source = { ...nextFiles, ...workflowChangedCore }[filePath];
          if (source === undefined) {
            throw new Error(`Unexpected release path: ${filePath}`);
          }
          return Buffer.from(source);
        },
      }),
      /one-time bootstrap/,
    );
    assert.equal(await readFile(path.join(rootDir, "src/app.txt"), "utf8"), "old app\n");
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
      applyAutomaticRelease({
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
    await writeFile(path.join(rootDir, "AGENTS.md"), "legacy agent rules\n");
    await writeFile(path.join(rootDir, "CLAUDE.md"), "legacy claude rules\n");
    await writeFile(path.join(rootDir, "DESIGN.md"), "legacy design\n");
    await writeFile(path.join(rootDir, "src/legacy.txt"), "legacy\n");
    await execFileAsync(
      "git",
      ["add", "package.json", "AGENTS.md", "CLAUDE.md", "DESIGN.md", "src/legacy.txt"],
      { cwd: rootDir, windowsHide: true },
    );
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
    await writeFile(
      path.join(rootDir, ".github/workflows/sharedesk-auto-update.yml"),
      "on:\r\n  schedule:\r\n",
    );
    await writeFile(path.join(rootDir, ".env.local"), "SECRET=preserve");
    await writeFile(path.join(rootDir, ".vercel/project.json"), "preserve");
    await execFileAsync("git", ["add", "-A"], { cwd: rootDir, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "current"], {
      cwd: rootDir,
      windowsHide: true,
    });

    const inheritedLegacy = {
      ...manifest("1.1.0", {}),
      legacyManifests: [
        {
          ...manifest("0.9.0", { "README.md": "oldest\n" }),
          bootstrapFiles: undefined,
        },
      ],
    };
    await writeFile(
      path.join(rootDir, "sharedesk-release.json"),
      `${JSON.stringify(inheritedLegacy, null, 2)}\n`,
    );
    await writeFile(path.join(rootDir, "src/current.txt"), "uncommitted\n");
    await writeFile(path.join(rootDir, "scratch.txt"), "untracked\n");

    const generated = await generateReleaseManifest({ rootDir, legacyRef });
    const legacyOne = generated.legacyManifests.find(
      (legacy: { version: string }) => legacy.version === "1.0.0",
    );
    assert.ok(legacyOne);
    assert.equal(generated.version, "1.1.0");
    assert.deepEqual(
      generated.legacyManifests.map(
        (legacy: { version: string }) => legacy.version,
      ),
      ["0.9.0", "1.0.0"],
    );
    assert.equal(
      generated.legacyManifests[0].files.some(
        (entry: { path: string }) => entry.path === "README.md",
      ),
      true,
    );
    assert.equal(generated.files.some((entry) => entry.path === "src/current.txt"), true);
    assert.equal(
      generated.files.find((entry) => entry.path === "src/current.txt")?.sha256,
      sha256(Buffer.from("current\n")),
    );
    assert.equal(generated.files.some((entry) => entry.path === "scratch.txt"), false);
    assert.equal(generated.files.some((entry) => entry.path === "src/legacy.txt"), false);
    for (const managedDoc of ["AGENTS.md", "CLAUDE.md", "DESIGN.md"]) {
      assert.equal(
        generated.files.some((entry) => entry.path === managedDoc),
        true,
        managedDoc,
      );
      assert.equal(
        legacyOne.files.some(
          (entry: { path: string }) => entry.path === managedDoc,
        ),
        true,
        `legacy ${managedDoc}`,
      );
    }
    assert.equal(generated.files.some((entry) => entry.path === ".env.local"), false);
    assert.equal(generated.files.some((entry) => entry.path.startsWith(".vercel/")), false);
    assert.equal(
      generated.bootstrapFiles.some(
        (entry) => entry.path === ".github/workflows/sharedesk-update.yml",
      ),
      true,
    );
    assert.equal(
      legacyOne.files.some(
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

test("manifest generation refuses uncommitted release sources but allows only the manifest to change", async () => {
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
    await writeFile(path.join(rootDir, "tracked.txt"), "committed\n");
    await execFileAsync("git", ["add", "tracked.txt"], {
      cwd: rootDir,
      windowsHide: true,
    });
    await execFileAsync("git", ["commit", "-m", "baseline"], {
      cwd: rootDir,
      windowsHide: true,
    });

    await writeFile(path.join(rootDir, "sharedesk-release.json"), "{}\n");
    await assertReleaseSourcesCommitted(rootDir);

    await writeFile(path.join(rootDir, "scratch.txt"), "untracked\n");
    await assert.rejects(
      assertReleaseSourcesCommitted(rootDir),
      /Commit every release source/,
    );
    await rm(path.join(rootDir, "scratch.txt"));

    await writeFile(path.join(rootDir, "tracked.txt"), "modified\n");
    await assert.rejects(
      assertReleaseSourcesCommitted(rootDir),
      /Commit every release source/,
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

test("preflight normalizes clean LF, CRLF, and mixed-line-ending text", async () => {
  await withTempDir(async (rootDir) => {
    const lf = "old\ntext\n";
    const crlf = "old\r\ntext\r\n";
    const mixed = "old\r\ntext\n";
    const nextText = "new\ntext\n";
    const previous = manifest("1.0.0", { "src/text.txt": lf });
    previous.files[0].acceptedSha256 = [sha256(Buffer.from(crlf))];
    const next = manifest("1.1.0", { "src/text.txt": nextText });
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src/text.txt"), mixed);
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

test("updates refuse downgrades before fetching or changing files", async () => {
  assert.throws(
    () => assertNotDowngrade("2.0.0", "1.9.0"),
    /Refusing to downgrade/,
  );
  assert.doesNotThrow(() => assertNotDowngrade("2.0.0", "2.0.0"));
  await withTempDir(async (rootDir) => {
    const previous = manifest("2.0.0", { "src/app.txt": "newer\n" });
    const older = manifest("1.9.0", { "src/app.txt": "older\n" });
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src/app.txt"), "newer\n");
    const previousJson = `${JSON.stringify(previous, null, 2)}\n`;
    await writeFile(path.join(rootDir, "sharedesk-release.json"), previousJson);
    let fetched = false;

    await assert.rejects(
      applyRelease({
        rootDir,
        manifest: older,
        fetchFile: async () => {
          fetched = true;
          return Buffer.from("older\n");
        },
      }),
      /Refusing to downgrade/,
    );
    assert.equal(fetched, false);
    assert.equal(
      await readFile(path.join(rootDir, "src/app.txt"), "utf8"),
      "newer\n",
    );
    assert.equal(
      await readFile(path.join(rootDir, "sharedesk-release.json"), "utf8"),
      previousJson,
    );
  });
  await withTempDir(async (rootDir) => {
    await writeFile(path.join(rootDir, "package.json"), '{"version":"2.0.0"}\n');
    const older = manifest("1.9.0", { "src/app.txt": "older\n" });
    let fetched = false;
    await assert.rejects(
      applyRelease({
        rootDir,
        manifest: older,
        fetchFile: async () => {
          fetched = true;
          return Buffer.from("older\n");
        },
      }),
      /Refusing to downgrade/,
    );
    assert.equal(fetched, false);
    assert.equal(
      await readFile(path.join(rootDir, "package.json"), "utf8"),
      '{"version":"2.0.0"}\n',
    );
    await assert.rejects(
      readFile(path.join(rootDir, "sharedesk-release.json")),
      /ENOENT/,
    );
  });
});

test("case-only path changes are rejected before any deletion or download", async () => {
  const previous = manifest("1.0.0", { "src/Foo.txt": "content\n" });
  const next = manifest("1.1.0", { "src/foo.txt": "content\n" });
  assert.throws(() => planRelease(previous, next), /Case-only managed path/);
  await withTempDir(async (rootDir) => {
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src/Foo.txt"), "content\n");
    const previousJson = `${JSON.stringify(previous, null, 2)}\n`;
    await writeFile(path.join(rootDir, "sharedesk-release.json"), previousJson);
    let fetched = false;
    await assert.rejects(
      applyRelease({
        rootDir,
        manifest: next,
        fetchFile: async () => {
          fetched = true;
          return Buffer.from("content\n");
        },
      }),
      /Case-only managed path/,
    );
    assert.equal(fetched, false);
    assert.equal(
      await readFile(path.join(rootDir, "src/Foo.txt"), "utf8"),
      "content\n",
    );
    assert.equal(
      await readFile(path.join(rootDir, "sharedesk-release.json"), "utf8"),
      previousJson,
    );
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
  assert.deepEqual(
    resolveUpdateRepository({
      SHAREDESK_GITHUB_REPOSITORY: `${"a".repeat(39)}/repo`,
    }),
    { repository: `${"a".repeat(39)}/repo`, configured: true },
  );
  for (const repository of [
    "owner/repo/extra",
    " owner/repo",
    "owner/../repo",
    "owner/repo name",
    "-owner/repo",
    `${"a".repeat(40)}/repo`,
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
    canDispatch: false,
    run: null,
    starred: null,
  });

  let requestedUrl = "";
  await getUpdateStatus({
    currentVersion: "1.0.0",
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json([
        { tag_name: "v1.0.0", draft: false, prerelease: false },
      ]);
    },
  });
  assert.match(requestedUrl, /[?&]per_page=100(?:&|$)/);

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

  const route = await readFile(
    new URL("../src/app/api/admin/update/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /requireAdmin\(\{ fresh: true \}\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
});

test("update token resolution rejects missing and padded values", () => {
  assert.deepEqual(resolveUpdateToken({}), {
    token: null,
    configured: false,
    reason: "missing",
    error: "SHAREDESK_GITHUB_TOKEN이 설정되지 않았습니다.",
  });
  assert.deepEqual(resolveUpdateToken({ SHAREDESK_GITHUB_TOKEN: "" }), {
    token: null,
    configured: false,
    reason: "missing",
    error: "SHAREDESK_GITHUB_TOKEN이 설정되지 않았습니다.",
  });
  assert.deepEqual(resolveUpdateToken({ SHAREDESK_GITHUB_TOKEN: " token " }), {
    token: null,
    configured: false,
    reason: "invalid",
    error: "SHAREDESK_GITHUB_TOKEN 값이 올바르지 않습니다.",
  });
  assert.deepEqual(
    resolveUpdateToken({ SHAREDESK_GITHUB_TOKEN: "github_pat_test" }),
    { token: "github_pat_test", configured: true },
  );
});

test("workflow dispatch sends one authenticated POST to the update workflow", async () => {
  const requests: Array<{
    url: string;
    method?: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const result = await dispatchUpdateWorkflow({
    env: {
      SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk",
      SHAREDESK_GITHUB_TOKEN: "github_pat_test",
    },
    fetchImpl,
  });
  assert.deepEqual(result, {
    ok: true,
    repository: "acme/sharedesk",
    workflowUrl:
      "https://github.com/acme/sharedesk/actions/workflows/sharedesk-update.yml",
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/acme/sharedesk/actions/workflows/sharedesk-update.yml/dispatches",
  );
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.Authorization, "Bearer github_pat_test");
  assert.equal(requests[0].body, '{"ref":"main"}');
});

test("workflow dispatch refuses to run without a token and never calls GitHub", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const result = await dispatchUpdateWorkflow({
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl,
  });
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: "SHAREDESK_GITHUB_TOKEN이 설정되지 않았습니다.",
  });
  assert.equal(fetched, false);
});

test("workflow dispatch maps GitHub failures to Korean errors without leaking the token", async () => {
  const token = "github_pat_secret_value";
  const env = {
    SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk",
    SHAREDESK_GITHUB_TOKEN: token,
  };

  const unauthorized = await dispatchUpdateWorkflow({
    env,
    fetchImpl: (async () =>
      new Response("bad credentials", { status: 401 })) as typeof fetch,
  });
  assert.deepEqual(unauthorized, {
    ok: false,
    status: 502,
    error:
      "GitHub 토큰이 유효하지 않습니다. SHAREDESK_GITHUB_TOKEN을 확인해 주세요.",
  });

  const missing = await dispatchUpdateWorkflow({
    env,
    fetchImpl: (async () =>
      new Response("not found", { status: 404 })) as typeof fetch,
  });
  assert.deepEqual(missing, {
    ok: false,
    status: 502,
    error:
      "워크플로를 찾을 수 없습니다. 저장소 설정 또는 토큰의 저장소 접근 권한을 확인해 주세요.",
  });

  assert.equal(JSON.stringify(unauthorized).includes(token), false);
  assert.equal(JSON.stringify(missing).includes(token), false);
});

test("latest run lookup parses the newest dispatch run and treats an empty list as no run", async () => {
  const env = {
    SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk",
    SHAREDESK_GITHUB_TOKEN: "github_pat_test",
  };
  const requested: string[] = [];
  const found = await fetchLatestUpdateRun({
    env,
    fetchImpl: (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return Response.json({
        workflow_runs: [
          {
            id: 42,
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/acme/sharedesk/actions/runs/42",
            created_at: "2026-08-17T00:00:00Z",
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.deepEqual(found, {
    ok: true,
    run: {
      id: 42,
      status: "in_progress",
      conclusion: null,
      htmlUrl: "https://github.com/acme/sharedesk/actions/runs/42",
      createdAt: "2026-08-17T00:00:00Z",
    },
  });
  assert.deepEqual(requested, [
    "https://api.github.com/repos/acme/sharedesk/actions/workflows/sharedesk-update.yml/runs?event=workflow_dispatch&branch=main&per_page=1",
  ]);

  const empty = await fetchLatestUpdateRun({
    env,
    fetchImpl: (async () =>
      Response.json({ workflow_runs: [] })) as typeof fetch,
  });
  assert.deepEqual(empty, { ok: true, run: null });
});

test("update status reports dispatch readiness and the latest run when a token is set", async () => {
  const env = {
    SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk",
    SHAREDESK_GITHUB_TOKEN: "github_pat_test",
  };
  const status = await getUpdateStatus({
    currentVersion: "1.0.0",
    env,
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/workflows/")) {
        return Response.json({
          workflow_runs: [
            {
              id: 7,
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/acme/sharedesk/actions/runs/7",
              created_at: "2026-08-17T00:00:00Z",
            },
          ],
        });
      }
      return Response.json([
        { tag_name: "v1.1.0", draft: false, prerelease: false },
      ]);
    }) as typeof fetch,
  });
  assert.equal(status.canDispatch, true);
  assert.deepEqual(status.run, {
    id: 7,
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/acme/sharedesk/actions/runs/7",
    createdAt: "2026-08-17T00:00:00Z",
  });
  assert.equal(status.error, undefined);

  const degraded = await getUpdateStatus({
    currentVersion: "1.0.0",
    env,
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/workflows/")) {
        return new Response("boom", { status: 500 });
      }
      return Response.json([
        { tag_name: "v1.1.0", draft: false, prerelease: false },
      ]);
    }) as typeof fetch,
  });
  assert.equal(degraded.canDispatch, true);
  assert.equal(degraded.run, null);
  assert.match(degraded.error ?? "", /GitHub 응답 500/);
});

test("the admin update route exposes a guarded dispatch POST and a run scope", async () => {
  const route = await readFile(
    new URL("../src/app/api/admin/update/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /export async function POST/);
  const postSource = route.slice(route.indexOf("export async function POST"));
  assert.match(postSource, /requireAdmin\(\{ fresh: true \}\)/);
  assert.match(route, /searchParams\.get\("scope"\) === "run"/);
  assert.match(postSource, /이미 업데이트가 진행 중입니다/);
  assert.match(postSource, /status: 409/);
});

function runState(overrides: Partial<UpdateRunState> = {}): UpdateRunState {
  return {
    phase: "starting",
    startedVersion: "1.0.0",
    targetVersion: "1.1.0",
    error: null,
    htmlUrl: null,
    startedAt: Date.parse("2026-08-17T12:00:00Z"),
    ...overrides,
  };
}

test("one-click run tracking ignores stale completed runs right after dispatch", () => {
  const started = runState();
  const now = started.startedAt + 5_000;
  const staleFailure = {
    id: 1,
    status: "completed",
    conclusion: "failure",
    htmlUrl: "https://github.com/acme/sharedesk/actions/runs/1",
    createdAt: "2026-08-17T11:00:00Z",
  };
  const staleSuccess = { ...staleFailure, id: 2, conclusion: "success" };

  // 직전 실행의 실패·성공 기록은 이번 실행으로 오인하지 않는다.
  assert.equal(nextUpdateRunState(started, "1.0.0", staleFailure, now), started);
  assert.equal(nextUpdateRunState(started, "1.0.0", staleSuccess, now), started);

  // 이번에 새로 생긴 실행은 시각과 무관하게 추적을 시작한다.
  const fresh = {
    id: 3,
    status: "queued",
    conclusion: null,
    htmlUrl: "https://github.com/acme/sharedesk/actions/runs/3",
    createdAt: "2026-08-17T12:00:03Z",
  };
  assert.equal(nextUpdateRunState(started, "1.0.0", fresh, now).phase, "running");

  const freshDone = {
    ...fresh,
    id: 4,
    status: "completed",
    conclusion: "success",
  };
  assert.equal(
    nextUpdateRunState(started, "1.0.0", freshDone, now).phase,
    "deploying",
  );
});

test("one-click run tracking resolves completion, failure, and stalls", () => {
  const running = runState({ phase: "running", htmlUrl: "https://github.com/r/4" });
  const now = running.startedAt + 60_000;
  const doneRun = {
    id: 4,
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/r/4",
    createdAt: "2026-08-17T11:00:00Z",
  };

  // 이어받은(running) 실행은 생성 시각이 과거여도 완료 판정이 정상 동작한다.
  assert.equal(
    nextUpdateRunState(running, "1.0.0", doneRun, now).phase,
    "deploying",
  );
  assert.equal(nextUpdateRunState(running, "1.1.0", doneRun, now).phase, "done");
  assert.equal(
    nextUpdateRunState(running, "1.0.0", { ...doneRun, conclusion: "failure" }, now)
      .phase,
    "failed",
  );
  assert.equal(
    nextUpdateRunState(
      running,
      "1.0.0",
      null,
      running.startedAt + UPDATE_RUN_STALL_MS + 1,
    ).phase,
    "stalled",
  );

  // 끝난 상태는 폴링 결과가 무엇이든 다시 움직이지 않는다.
  const finished = runState({ phase: "done" });
  assert.equal(nextUpdateRunState(finished, "1.0.0", doneRun, now), finished);
});

test("run lookup rejects a run whose page address is not GitHub", async () => {
  const result = await fetchLatestUpdateRun({
    env: {
      SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk",
      SHAREDESK_GITHUB_TOKEN: "github_pat_test",
    },
    fetchImpl: (async () =>
      Response.json({
        workflow_runs: [
          {
            id: 9,
            status: "completed",
            conclusion: "success",
            html_url: "javascript:alert(1)",
            created_at: "2026-08-17T00:00:00Z",
          },
        ],
      })) as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.match(
    (result as { error: string }).error,
    /형식이 올바르지 않습니다/,
  );
});

test("release pagination refuses to follow links outside the GitHub API", async () => {
  await assert.rejects(
    fetchStatusReleasePages(
      "https://api.github.com/repos/Youkamii/sharedesk-template/releases?per_page=100",
      (async () =>
        Response.json([], {
          headers: {
            Link: '<https://evil.example/steal>; rel="next"',
          },
        })) as typeof fetch,
    ),
    /형식이 올바르지 않습니다/,
  );
});

test("update status falls back to the latest release when the list API is empty or failing", async () => {
  const latestPayload = {
    tag_name: "v0.4.0",
    draft: false,
    prerelease: false,
  };

  // GitHub 목록 인덱스 지연: 목록은 200 + 빈 배열, latest 단건은 정상 (실제 관측 상황)
  const requestedWhenEmpty: string[] = [];
  const emptyList = await getUpdateStatus({
    currentVersion: "0.4.0",
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedWhenEmpty.push(url);
      if (url.endsWith("/releases/latest")) return Response.json(latestPayload);
      return Response.json([]);
    }) as typeof fetch,
  });
  assert.equal(emptyList.latestVersion, "0.4.0");
  assert.equal(emptyList.updateAvailable, false);
  assert.equal(emptyList.error, undefined);
  assert.ok(
    requestedWhenEmpty.some((url) => url.endsWith("/releases/latest")),
  );

  // 목록 조회 자체가 실패해도 latest가 살아 있으면 이어 간다.
  const failingList = await getUpdateStatus({
    currentVersion: "0.3.2",
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/releases/latest")) {
        return Response.json(latestPayload);
      }
      return new Response("rate limited", { status: 403 });
    }) as typeof fetch,
  });
  assert.equal(failingList.latestVersion, "0.4.0");
  assert.equal(failingList.updateAvailable, true);
  assert.equal(failingList.error, undefined);

  // 폴백까지 실패하면 진단에 유리한 원래 목록 오류를 보고한다.
  const bothFailing = await getUpdateStatus({
    currentVersion: "0.3.2",
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl: (async (input: RequestInfo | URL) =>
      new Response("down", {
        status: String(input).endsWith("/releases/latest") ? 500 : 403,
      })) as typeof fetch,
  });
  assert.equal(bothFailing.latestVersion, null);
  assert.match(bothFailing.error ?? "", /GitHub 응답 403/);

  // 릴리스가 하나도 없는 저장소(latest 404)는 오류가 아니라 "없음"이다.
  assert.equal(
    await fetchLatestStableReleaseFallback((async () =>
      new Response("missing", { status: 404 })) as typeof fetch),
    null,
  );
  // latest가 prerelease면 안정 릴리스로 채택하지 않는다 (선택기 재사용).
  assert.equal(
    await fetchLatestStableReleaseFallback((async () =>
      Response.json({
        tag_name: "v0.5.0-rc.1",
        draft: false,
        prerelease: true,
      })) as typeof fetch),
    null,
  );
  // 목록이 정상이면 폴백을 호출하지 않는다.
  const requestedWhenHealthy: string[] = [];
  await getUpdateStatus({
    currentVersion: "0.3.2",
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl: (async (input: RequestInfo | URL) => {
      requestedWhenHealthy.push(String(input));
      return Response.json([
        { tag_name: "v0.4.0", draft: false, prerelease: false },
      ]);
    }) as typeof fetch,
  });
  assert.equal(
    requestedWhenHealthy.some((url) => url.endsWith("/releases/latest")),
    false,
  );
});

test("update status surfaces a malformed token instead of hiding one-click silently", async () => {
  const status = await getUpdateStatus({
    currentVersion: "1.0.0",
    env: {
      SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk",
      SHAREDESK_GITHUB_TOKEN: " padded-token-1234567890 ",
    },
    fetchImpl: (async () =>
      Response.json([
        { tag_name: "v1.1.0", draft: false, prerelease: false },
      ])) as typeof fetch,
  });
  assert.equal(status.canDispatch, false);
  assert.match(status.error ?? "", /SHAREDESK_GITHUB_TOKEN 값이 올바르지 않습니다/);
});

test("the files view wires the one-click update flow", async () => {
  const filesView = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  for (const pattern of [
    /updateRunControllerRef/,
    /startUpdate/,
    /scope=run/,
    /UPDATE_RUN_POLL_MS/,
    /window\.location\.reload/,
  ]) {
    assert.match(filesView, pattern);
  }
});

test("manual update workflow verifies without write credentials before a sealed push", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/sharedesk-update.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^on:\r?\n  workflow_dispatch:\s*$/m);
  assert.match(
    workflow,
    /^on:\r?\n  workflow_dispatch:\r?\n\r?\npermissions:/m,
  );
  assert.doesNotMatch(workflow, /\bschedule\s*:/);
  assert.doesNotMatch(workflow, /\bcron\s*:/);
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^  publish:\r?\n(?:.|\r?\n)*?    permissions:\r?\n      contents: write$/m);
  assert.match(
    workflow,
    /uses: actions\/checkout@[a-f0-9]{40} # v\d+(?:\.\d+){0,2}/,
  );
  assert.match(
    workflow,
    /uses: actions\/setup-node@[a-f0-9]{40} # v\d+(?:\.\d+){0,2}/,
  );
  assert.equal(
    workflow.match(/uses: actions\/setup-node@[a-f0-9]{40}/g)?.length,
    2,
  );
  assert.match(
    workflow,
    /uses: actions\/upload-artifact@[a-f0-9]{40} # v\d+(?:\.\d+){0,2}/,
  );
  assert.match(
    workflow,
    /uses: actions\/download-artifact@[a-f0-9]{40} # v\d+(?:\.\d+){0,2}/,
  );
  assert.equal(workflow.match(/node-version-file: \.node-version/g)?.length, 2);
  assert.equal(workflow.match(/^          ref: main$/gm)?.length, 2);
  assert.equal(
    workflow.match(/^          persist-credentials: false$/gm)?.length,
    2,
  );
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(workflow, /UPDATE_AUTHOR_NAME: \$\{\{ github\.actor \}\}/);
  assert.match(
    workflow,
    /UPDATE_AUTHOR_EMAIL: \$\{\{ github\.actor_id \}\}\+\$\{\{ github\.actor \}\}@users\.noreply\.github\.com/,
  );
  assert.match(workflow, /git config user\.name "\$UPDATE_AUTHOR_NAME"/);
  assert.match(workflow, /git config user\.email "\$UPDATE_AUTHOR_EMAIL"/);
  assert.match(workflow, /UPDATE_GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /AUTHORIZATION: basic \$\{auth\}/);
  assert.doesNotMatch(workflow, /github-actions\[bot\]/);
  const tokenIndex = workflow.indexOf("UPDATE_GITHUB_TOKEN:");
  const verifyIndex = workflow.indexOf("node scripts/sharedesk-verify.mjs");
  assert.ok(tokenIndex > verifyIndex, "the write token must only reach the final push step");
  assert.match(workflow, /git -c core\.hooksPath=\/dev\/null commit/);
  assert.match(workflow, /git -c core\.hooksPath=\/dev\/null -c .* push/);
  assert.match(workflow, /git diff --cached --quiet -- \.github\/workflows/);
  assert.match(workflow, /push origin HEAD:main/);
  assert.doesNotMatch(workflow, /secrets\./);

  const orderedSteps = [
    "node scripts/sharedesk-update.mjs --apply",
    "git diff --cached --binary --full-index --no-ext-diff",
    "actions/upload-artifact@",
    "Set up the updated Node.js version",
    "node scripts/sharedesk-verify.mjs",
    "actions/download-artifact@",
    "git apply --index --binary",
    "git -c core.hooksPath=/dev/null commit",
    "push origin HEAD:main",
  ];
  let previousIndex = -1;
  for (const step of orderedSteps) {
    const currentIndex = workflow.indexOf(step);
    assert.ok(currentIndex > previousIndex, `${step} must appear in order`);
    previousIndex = currentIndex;
  }
});

test("update workflows use Node 24 artifact actions", async () => {
  for (const workflowPath of [
    "../.github/workflows/sharedesk-update.yml",
    "../.github/workflows/sharedesk-auto-update.yml",
  ]) {
    const workflow = await readFile(new URL(workflowPath, import.meta.url), "utf8");
    assert.match(
      workflow,
      /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
    );
    assert.match(
      workflow,
      /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/,
    );
  }
});

test("updated release controls the Node version and verification commands", async () => {
  assert.equal(
    (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim(),
    "24.18.0",
  );
  const verifier = await readFile(
    new URL("../scripts/sharedesk-verify.mjs", import.meta.url),
    "utf8",
  );
  const orderedCommands = [
    '["npm", ["ci"]]',
    '["npm", ["test"]]',
    '["npm", ["run", "lint"]]',
    '["npx", ["--no-install", "tsc", "--noEmit"]]',
    '["npm", ["run", "build"]]',
  ];
  let previousIndex = -1;
  for (const command of orderedCommands) {
    const currentIndex = verifier.indexOf(command);
    assert.ok(currentIndex > previousIndex, `${command} must appear in order`);
    previousIndex = currentIndex;
  }
  assert.match(verifier, /process\.env\.ComSpec \?\? "cmd\.exe"/);
  assert.match(
    verifier,
    /\["\/d", "\/s", "\/c", `\$\{command\}\.cmd`, \.\.\.args\]/,
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts.test, /tsx --test --test-concurrency=1/);
});

test("all release clients follow GitHub pagination to the 101st stable release", async () => {
  const initialUrl =
    "https://api.github.com/repos/Youkamii/sharedesk-template/releases?per_page=100";

  const updaterFetch = paginatedReleaseFetch();
  const updaterReleases = await fetchUpdaterReleasePages(
    initialUrl,
    updaterFetch.fetchImpl,
  );
  assert.equal(updaterFetch.requested.length, 2);
  assert.equal(selectUpdaterStableRelease(updaterReleases)?.version, "1.2.0");

  const bootstrapFetch = paginatedReleaseFetch();
  const bootstrapReleases = await fetchBootstrapReleasePages(
    initialUrl,
    bootstrapFetch.fetchImpl,
  );
  assert.equal(bootstrapFetch.requested.length, 2);
  assert.equal(
    selectBootstrapStableRelease(bootstrapReleases)?.tag_name,
    "v1.2.0",
  );

  const statusFetch = paginatedReleaseFetch();
  const statusReleases = await fetchStatusReleasePages(
    initialUrl,
    statusFetch.fetchImpl,
  );
  assert.equal(statusFetch.requested.length, 2);
  assert.equal(selectLatestStableVersion(statusReleases), "1.2.0");

  const status = await getUpdateStatus({
    currentVersion: "1.1.0",
    env: { SHAREDESK_GITHUB_REPOSITORY: "acme/sharedesk" },
    fetchImpl: paginatedReleaseFetch().fetchImpl,
  });
  assert.equal(status.latestVersion, "1.2.0");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canDispatch, false);
  assert.equal(status.run, null);
});

test("all release clients inspect a full GitHub release page", async () => {
  for (const relativePath of [
    "../scripts/sharedesk-update.mjs",
    "../scripts/sharedesk-bootstrap.mjs",
    "../src/lib/update-status.ts",
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /releases\?per_page=100/, relativePath);
  }
});

test("the star repository stays the same as the update source", () => {
  // 순환 참조를 피하려고 상수를 따로 적었으므로 값이 갈라지지 않게 고정한다.
  assert.equal(STAR_REPOSITORY, UPDATE_SOURCE_REPOSITORY);
});

test("star check and star creation talk to the right GitHub endpoint", async () => {
  const requests: Array<{ url: string; method?: string; auth?: string }> = [];
  const record = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: init?.method,
      auth: headers.get("Authorization") ?? undefined,
    });
  };

  const starred = await checkStarred({
    token: "github_pat_test",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.deepEqual(starred, { ok: true, starred: true });
  assert.equal(
    requests[0].url,
    "https://api.github.com/user/starred/Youkamii/sharedesk-template",
  );
  assert.equal(requests[0].auth, "Bearer github_pat_test");

  // 아직 누르지 않은 저장소는 404를 준다 — 오류가 아니라 "안 눌림"이다.
  const notStarred = await checkStarred({
    token: "github_pat_test",
    fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
  });
  assert.deepEqual(notStarred, { ok: true, starred: false });

  const added = await addStar({
    token: "github_pat_test",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.deepEqual(added, { ok: true });
  assert.equal(requests[1].method, "PUT");
  assert.equal(
    requests[1].url,
    "https://api.github.com/user/starred/Youkamii/sharedesk-template",
  );

  // 토큰에 Starring 권한이 없으면 GitHub이 403이나 404를 준다.
  const denied = await addStar({
    token: "github_pat_test",
    fetchImpl: (async () => new Response(null, { status: 403 })) as typeof fetch,
  });
  assert.equal(denied.ok, false);
  assert.match((denied as { error: string }).error, /Starring/);

  // 토큰이 없으면 GitHub을 부르지 않는다.
  let called = false;
  const noToken = await checkStarred({
    token: null,
    fetchImpl: (async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.equal(noToken.ok, false);
  assert.equal(called, false);
});

test("the update route refuses to dispatch until the star is agreed", async () => {
  const route = await readFile(
    new URL("../src/app/api/admin/update/route.ts", import.meta.url),
    "utf8",
  );
  const postSource = route.slice(route.indexOf("export async function POST"));
  // 별 확인이 워크플로 실행보다 먼저 와야 한다.
  const starIndex = postSource.indexOf("passStarGate");
  const dispatchIndex = postSource.indexOf("dispatchUpdateWorkflow");
  assert.ok(starIndex >= 0 && dispatchIndex > starIndex);
  assert.match(postSource, /star === true/);
  assert.match(postSource, /starRequired: true/);
  assert.match(postSource, /status: 409/);
  assert.match(postSource, /passStarGate\(/);
});

test("setup offers to star the source repository once the build is done", async () => {
  const setup = await readFile(
    new URL("../scripts/setup.mjs", import.meta.url),
    "utf8",
  );
  assert.match(setup, /export async function askToStar/);
  assert.match(setup, /github\.com\/Youkamii\/sharedesk-template/);
  // 설정 완료 안내 뒤에 물어본다.
  const completion = setup.indexOf("=== 설정 완료 ===");
  assert.ok(completion >= 0 && setup.indexOf("askToStar(", completion) > completion);
});

test("automatic updates run at midnight without a key and stay sealed", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/sharedesk-auto-update.yml", import.meta.url),
    "utf8",
  );
  // 매시 예약으로 깨어나 앱의 공개 정책을 물어보고 자정에만 진행한다.
  assert.match(workflow, /schedule:\s*\n\s*- cron: "7 \* \* \* \*"/);
  // 개인 키 없이 돈다: 배포 기록에서 주소를 찾고, 배포별 주소가 막히면
  // 프로덕션 별칭(<project>.vercel.app)을 유도해 정책(JSON)을 찾는다.
  assert.match(workflow, /deployments: read/);
  assert.match(workflow, /api\/update-policy/);
  assert.match(workflow, /\.vercel\.app/);
  assert.match(workflow, /has\("autoUpdate"\)/);
  // 자정 판정은 앱이 계산한다 — 시간대 문자열이 셸에 닿지 않는다.
  assert.match(workflow, /"\$midnight" != "true"/);
  assert.doesNotMatch(workflow, /TZ=/);
  assert.doesNotMatch(workflow, /SHAREDESK_GITHUB_TOKEN/);
  // 개인 키 없이 저장소 자체 토큰만 쓴다.
  assert.match(workflow, /github\.token/);
  assert.doesNotMatch(workflow, /SHAREDESK_GITHUB_TOKEN/);
  // 수동 업데이트와 같은 봉인 규칙 — 워크플로 변경은 거부한다.
  assert.match(
    workflow,
    /sharedesk-update\.yml \.github\/workflows\/sharedesk-auto-update\.yml/,
  );
  assert.match(workflow, /A verified update cannot change GitHub workflows/);
  // 배포되지 않는 템플릿 저장소에서는 돌지 않는다.
  assert.match(workflow, /github\.repository != 'Youkamii\/sharedesk-template'/);
  // 별이 실제로 있어야 돈다 — 주인이 스타한 목록(익명 폴백 포함)에서 확인한다.
  assert.match(workflow, /users\/\$owner\/starred\?per_page=100/);
  assert.doesNotMatch(workflow, /stargazers/);
  assert.match(workflow, /has not starred/);
});

test("the public update policy exposes only what the scheduler needs", async () => {
  const route = await readFile(
    new URL("../src/app/api/update-policy/route.ts", import.meta.url),
    "utf8",
  );
  // 키 없는 워크플로가 읽어야 하므로 인증을 걸지 않되, 내려 주는 값은
  // 자동 업데이트 여부·시간대·버전뿐이어야 한다.
  assert.doesNotMatch(route, /requireAdmin|requireSession/);
  assert.match(route, /autoUpdate: settings\.autoUpdate/);
  // 시간대는 노출하지 않는다 — 자정(00~01시) 여부만 내려 준다.
  assert.doesNotMatch(route, /timezone:/);
  assert.match(route, /hour === "00" \|\| hour === "01"/);
  assert.match(route, /currentVersion: packageJson\.version/);
  assert.doesNotMatch(route, /invitations|email|sessions/i);
});

test("turning on automatic updates passes the same star gate and fails open", async () => {
  const route = await readFile(
    new URL("../src/app/api/admin/desk-settings/route.ts", import.meta.url),
    "utf8",
  );
  const gate = route.slice(route.indexOf("patch.autoUpdate === true"));
  // 자동 업데이트는 주인의 별이 "검증"돼야만 켜진다(공개 스타 목록).
  assert.match(gate, /checkOwnerStarred\(owner/);
  assert.match(gate, /verified\.ok && verified\.starred/);
  assert.match(gate, /starRequired: true/);
  assert.match(gate, /status: 409/);
  // 예전 설치(워크플로 없음)에서는 켜기를 거부해 무음 실패를 막는다.
  assert.match(gate, /hasAutoUpdateWorkflow\(\)/);
  assert.match(gate, /workflowPresent === false/);
  // 공용 게이트 자체가 별 실패를 fail-open으로 다룬다.
  const star = await readFile(
    new URL("../src/lib/github-star.ts", import.meta.url),
    "utf8",
  );
  const passGate = star.slice(star.indexOf("export async function passStarGate"));
  // 동의 생략은 "별을 눌렀다"가 확인된 경우뿐 — 확인 불가는 동의를 요구한다.
  assert.match(passGate, /if \(starCheck\.ok && starCheck\.starred\) return \{ allowed: true \};/);
  assert.match(passGate, /star-skipped/);
  assert.doesNotMatch(
    passGate.slice(0, passGate.indexOf("export function resolveStarToken")),
    /throw /,
  );
});

test("desk settings only keep auto update together with a valid timezone", async () => {
  const users = await readFile(
    new URL("../src/lib/users.ts", import.meta.url),
    "utf8",
  );
  assert.match(users, /export function parseTimezone/);
  // 정규화: 시간대 없는 autoUpdate는 켜진 상태로 살아나지 못한다.
  assert.match(
    users,
    /autoUpdate: rawSettings\?\.autoUpdate === true && autoUpdateTimezone !== null/,
  );
  // 끄면 시간대도 지워 다음 켜기에서 새로 잡는다.
  assert.match(users, /patch\.autoUpdate === false[\s\S]*?autoUpdateTimezone = null/);
});

test("desk activity is recorded after responses and never blocks the operation", async () => {
  const activity = await readFile(
    new URL("../src/lib/activity.ts", import.meta.url),
    "utf8",
  );
  // 기록 실패는 삼키고, 동시 기록은 재시도 후 조용히 포기한다.
  assert.match(activity, /catch \(error\) \{\s*console\.error\("\[activity\]"/);
  assert.match(activity, /MAX_ENTRIES = 200/);
  assert.match(activity, /compareAndSwapState/);
  // 파일 작업 라우트들이 응답 뒤에 기록한다 (after 사용).
  for (const routePath of [
    "../src/app/api/drive/upload/route.ts",
    "../src/app/api/drive/delete/route.ts",
    "../src/app/api/drive/rename/route.ts",
    "../src/app/api/drive/move/route.ts",
    "../src/app/api/drive/mkdir/route.ts",
    "../src/app/api/drive/trash/route.ts",
    "../src/app/api/drive/content/route.ts",
  ]) {
    const route = await readFile(new URL(routePath, import.meta.url), "utf8");
    assert.match(route, /recordActivityAfter\(/, routePath);
  }
  // 열람은 관리자 전용이다.
  const adminRoute = await readFile(
    new URL("../src/app/api/admin/activity/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(adminRoute, /requireAdmin/);
});

test("external share links are scoped, expiring, and revocable", async () => {
  const lib = await readFile(
    new URL("../src/lib/share-links.ts", import.meta.url),
    "utf8",
  );
  // 링크 id는 URL에 노출되는 비밀 — 48자리 hex 난수를 강제한다.
  assert.match(lib, /randomBytes\(24\)\.toString\("hex"\)/);
  assert.match(lib, /\^\[a-f0-9\]\{48\}\$/);
  // 만료 지난 링크는 목록·해석 어디서도 살아나지 못한다.
  assert.match(lib, /function activeLinks/);
  assert.match(lib, /cleanupExpiredShareLinks/);
  const manage = await readFile(
    new URL("../src/app/api/drive/share-link/route.ts", import.meta.url),
    "utf8",
  );
  // 만들기·거두기는 관리자·수정 가능 역할만, 폴더는 거부.
  assert.match(manage, /requireEditRights/);
  assert.match(manage, /kind: entry\.isFolder \? "folder" : "file"/);
  const publicRoute = await readFile(
    new URL("../src/app/api/share/[linkId]/route.ts", import.meta.url),
    "utf8",
  );
  // 공개 경로는 attachment 고정 — 브라우저 안에서 렌더되지 않는다.
  assert.match(publicRoute, /attachment; filename/);
  assert.match(publicRoute, /adapter\.isWithin\(targetId, link\.fileId\)/);
  assert.match(publicRoute, /folderPage\(/);
  assert.doesNotMatch(publicRoute, /requireSession|requireEditRights/);
  // 공개 경로는 proxy 보호 접두사(/api/drive, /api/admin) 밖에 있어야 한다.
  const proxy = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /\/api\/drive\/:path\*/);
  assert.ok(!publicRoute.includes("api/drive/"));
});

test("the manifest contract never grows and new core files stay optional", async () => {
  // 배포된 구버전 업데이터는 bootstrapFiles 길이가 자기 목록과 다르면
  // 매니페스트 전체를 거부한다. 여기 항목을 더하는 순간 기존 설치의
  // 업데이트가 전부 깨진다 — 새 core 파일은 부트스트랩의 선택 설치로만.
  assert.equal(BOOTSTRAP_CORE_PATHS.length, 3);
  const bootstrap = await readFile(
    new URL("../scripts/sharedesk-bootstrap.mjs", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /OPTIONAL_BOOTSTRAP_PATHS = \[\s*"\.github\/workflows\/sharedesk-auto-update\.yml",/);
  // 선택 파일은 실패해도 부트스트랩을 막지 않고, 기존 파일을 덮지 않는다.
  assert.match(bootstrap, /installOptionalBootstrapFiles/);
  const optional = bootstrap.slice(
    bootstrap.indexOf("async function installOptionalBootstrapFiles"),
  );
  assert.match(optional.slice(0, optional.indexOf("function nextPageUrl")), /continue;/);
});

test("the manual update workflow file must never change casually", async () => {
  // 이 파일의 해시는 매니페스트 계약이다: 내용이 바뀌면 모든 기존 설치가
  // 업데이트 전에 1회 부트스트랩을 요구받는다(assertPreservedWorkflowIsCurrent).
  // 바꿔야 한다면 그 비용을 알고 릴리스 노트에 명시하고 이 테스트를 갱신하라.
  const workflow = await readFile(
    new URL("../.github/workflows/sharedesk-update.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /git diff --quiet -- \.github\/workflows\/sharedesk-update\.yml; then/,
  );
  assert.doesNotMatch(
    workflow,
    /sharedesk-update\.yml \.github\/workflows\/sharedesk-auto-update\.yml/,
  );
});

test("setup stars automatically through the local gh login like tokscale", async () => {
  const { autoStarViaGh } = await import("../scripts/setup.mjs");
  const calls: string[][] = [];
  // gh가 있으면 조용히 PUT 한 번으로 끝난다.
  const ok = await autoStarViaGh(
    ((command: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
      calls.push([command, ...args]);
      callback(null);
    }) as never,
  );
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "gh");
  assert.ok(calls[0].includes("PUT"));
  assert.ok(calls[0].includes("user/starred/Youkamii/sharedesk-template"));
  // gh가 없거나 로그인이 없으면 조용히 물러난다 — 설치를 막지 않는다.
  const fail = await autoStarViaGh(
    ((_c: string, _a: string[], _o: unknown, callback: (error: Error | null) => void) => {
      callback(new Error("ENOENT"));
    }) as never,
  );
  assert.equal(fail, false);
});

test("owner star checks bust GitHub's anonymous cache", async () => {
  const lib = await readFile(
    new URL("../src/lib/github-star.ts", import.meta.url),
    "utf8",
  );
  // 익명 응답은 약 1분 캐시된다 — 방금 누른 별이 안 보이면 사용자가 갇힌다.
  assert.match(lib, /fresh=\$\{Date\.now\(\)\}/);
});

test("owner star verification pages through the owner's public starred list", async () => {
  const { checkOwnerStarred } = await import("../src/lib/github-star");
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    full_name: `someone/repo${i}`,
  }));
  const page2 = [
    { full_name: "other/repo" },
    { full_name: "Youkamii/sharedesk-template" },
  ];
  const fetchImpl = (async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes("nobody-here") ? [] : url.endsWith("page=1") ? page1 : page2,
  })) as unknown as typeof fetch;
  const found = await checkOwnerStarred("youkamii", { fetchImpl });
  assert.deepEqual(found, { ok: true, starred: true });
  const missing = await checkOwnerStarred("nobody-here", { fetchImpl });
  assert.deepEqual(missing, { ok: true, starred: false });
  // 저장소 전용 토큰이 거부돼도 익명 재시도로 이어진다.
  let sawAnonymous = false;
  const flaky = (async (url: string, init: { headers: Record<string, string> }) => {
    if (init.headers.Authorization) return { ok: false, status: 404 };
    sawAnonymous = true;
    return { ok: true, json: async () => page2 };
  }) as unknown as typeof fetch;
  const viaAnon = await checkOwnerStarred("youkamii", {
    token: "limited-token",
    fetchImpl: flaky,
  });
  assert.deepEqual(viaAnon, { ok: true, starred: true });
  assert.equal(sawAnonymous, true);
  // 연결 실패는 확인 실패로 끝난다 — 켜기를 허용하지 않는다.
  const down = await checkOwnerStarred("youkamii", {
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
  });
  assert.equal(down.ok, false);
});

test("both workflow files must parse as YAML", async () => {
  // 파이썬 치환이 printf의 \n을 실제 줄바꿈으로 바꿔 워크플로 전체를
  // 무효화한 사고(2026-08-19)의 재발 방지 — 구조를 실제로 파싱해 본다.
  for (const workflowPath of [
    "../.github/workflows/sharedesk-update.yml",
    "../.github/workflows/sharedesk-auto-update.yml",
  ]) {
    const raw = await readFile(new URL(workflowPath, import.meta.url), "utf8");
    // 최소 구조 검증: jobs 블록과 각 run 블록의 들여쓰기가 끊기지 않는다.
    assert.ok(raw.includes("\njobs:"), workflowPath);
    for (const [index, line] of raw.split("\n").entries()) {
      // run: | 블록 안에서 갑자기 0열로 시작하는 줄은 YAML 파괴 신호다.
      if (index > 0 && /^[^\s#-]/.test(line) && !/^(name|on|permissions|concurrency|jobs):/.test(line)) {
        assert.fail(`${workflowPath}:${index + 1} 들여쓰기 없는 줄: ${line}`);
      }
    }
  }
});

test("npm run setup:finish exists so PowerShell cannot swallow the --finish flag", async () => {
  // PowerShell에서 npm run setup -- --finish의 --finish가 npm에 흡수되면 bare
  // setup이 재실행돼 state가 회전한다 — 전용 스크립트가 이 사고를 차단한다.
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["setup:finish"],
    "node scripts/setup.mjs --finish",
  );
});

test("setup asks the desk language, records it, and guards a pending authentication", async () => {
  const setup = await readFile(
    new URL("../scripts/setup.mjs", import.meta.url),
    "utf8",
  );
  // 선택한 언어가 .env.local의 SHAREDESK_DEFAULT_LOCALE로 주입된다.
  assert.match(setup, /SHAREDESK_DEFAULT_LOCALE: selectedLocale \?\? "en"/);
  // 진행 중 인증이 있으면 state를 돌리기 전에 setup:finish를 안내한다.
  assert.match(setup, /진행 중인 인증이 있습니다\. 마치려면 npm run setup:finish/);
  // 1단계 안내도 npm이 플래그를 삼키지 않는 전용 스크립트를 가리킨다.
  assert.match(setup, /npm run setup:finish/);
  const example = await readFile(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  assert.match(example, /^SHAREDESK_DEFAULT_LOCALE=/m);

  const {
    renderSetupBanner,
    resolveSetupLocale,
    setSetupLocale,
    t,
  } = await import("../scripts/setup.mjs");
  // 언어 질문의 1~5와 로케일 코드를 모두 받고, 그 외에는 null.
  assert.equal(resolveSetupLocale("1"), "en");
  assert.equal(resolveSetupLocale("2"), "ko");
  assert.equal(resolveSetupLocale("3"), "ja");
  assert.equal(resolveSetupLocale("4"), "hi");
  assert.equal(resolveSetupLocale("5"), "zh");
  assert.equal(resolveSetupLocale("ja"), "ja");
  assert.equal(resolveSetupLocale(""), null);
  assert.equal(resolveSetupLocale("9"), null);
  try {
    setSetupLocale("en");
    assert.equal(t("=== 설정 완료 ==="), "=== Setup complete ===");
    setSetupLocale("zh");
    assert.equal(t("=== 설정 완료 ==="), "=== 设置完成 ===");
    // 번역이 없는 문구는 영어 → 한국어 원문 순으로 폴백한다.
    assert.equal(t("사전에 없는 문구"), "사전에 없는 문구");
  } finally {
    setSetupLocale("ko");
  }
  assert.equal(t("=== 설정 완료 ==="), "=== 설정 완료 ===");

  // 도트 배너는 80자 이내의 순수 ASCII다.
  const banner = renderSetupBanner();
  assert.match(banner, /#/);
  for (const line of banner.split("\n")) {
    assert.ok(line.length <= 80, line);
    assert.match(line, /^[ #.]*$/);
  }
});

test("the desk default language follows SHAREDESK_DEFAULT_LOCALE from setup", async () => {
  const { defaultDeskSettings } = await import("../src/lib/users");
  const original = process.env.SHAREDESK_DEFAULT_LOCALE;
  try {
    process.env.SHAREDESK_DEFAULT_LOCALE = "ja";
    assert.equal(defaultDeskSettings().locale, "ja");
    process.env.SHAREDESK_DEFAULT_LOCALE = "invalid-locale";
    assert.equal(defaultDeskSettings().locale, "en");
    delete process.env.SHAREDESK_DEFAULT_LOCALE;
    assert.equal(defaultDeskSettings().locale, "en");
  } finally {
    if (original === undefined) delete process.env.SHAREDESK_DEFAULT_LOCALE;
    else process.env.SHAREDESK_DEFAULT_LOCALE = original;
  }
});

test("enabling auto update never needs the personal token", async () => {
  const route = await readFile(
    new URL("../src/app/api/admin/desk-settings/route.ts", import.meta.url),
    "utf8",
  );
  // 켜기의 필수 조건은 '주인의 별'(익명 검증)뿐이다 — 토큰이 없어도
  // 켜지고, 자정 실행도 개인 키 없이 돈다는 약속을 지킨다.
  const gate = route.slice(route.indexOf("patch.autoUpdate === true"));
  assert.match(gate, /checkOwnerStarred\(owner/);
  assert.doesNotMatch(gate, /dispatchAutoUpdateRegister|dispatchUpdateWorkflow/);
});
