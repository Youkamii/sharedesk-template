import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("dawn wallpaper keeps its id while using the accurate dawn-light label", async () => {
  const [source, readme, koReadme] = await Promise.all([
    readFile(new URL("src/app/files/FilesView.tsx", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("README.ko.md", root), "utf8"),
  ]);

  assert.match(
    source,
    /\{ id: "dawn", name: "여명", src: "\/art\/wall-dawn\.png" \}/,
  );
  // 표 라벨은 헤더 행과 통일하려고 굵게 쓴다 — 굵기 표기는 선택적으로 본다.
  assert.match(readme, /\|\s*\*{0,2}Dawn\*{0,2}\s*\|\s*\*{0,2}Night [Tt]ide\*{0,2}\s*\|/);
  assert.match(
    readme,
    /!\[Dawn wallpaper\]\(\.\/docs\/sharedesk-wallpaper-dawn\.png\)/,
  );
  assert.match(koReadme, /\|\s*\*{0,2}여명\*{0,2}\s*\|\s*\*{0,2}밤바다\*{0,2}\s*\|/);
  assert.match(
    koReadme,
    /!\[여명 바탕화면\]\(\.\/docs\/sharedesk-wallpaper-dawn\.png\)/,
  );
  assert.doesNotMatch(source, /name: "새벽"/);
  assert.doesNotMatch(koReadme, /새벽 바탕화면/);
});

for (const name of ["wall-night.png", "wall-dawn.png", "wall-tide.png"]) {
  test(`${name} is a full-size PNG wallpaper`, async () => {
    const image = await readFile(new URL(`public/art/${name}`, root));

    assert.deepEqual([...image.subarray(0, 8)], [
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    assert.ok(image.readUInt32BE(16) >= 1_500);
    assert.ok(image.readUInt32BE(20) >= 1_000);
  });
}

test("night tide animates horizontal water bands without moving the sky", async () => {
  const css = await readFile(
    new URL("src/app/files/desktop.module.css", root),
    "utf8",
  );

  assert.match(css, /\.wallpaper\[style\*="wall-tide\.png"\]::before/);
  assert.match(css, /background-image: url\("\/art\/wall-tide\.png"\)/);
  assert.match(css, /mask-image: repeating-linear-gradient/);
  assert.match(css, /@keyframes tideWaves/);
  assert.match(css, /animation: tideWaves [^;]+ steps\(14, end\) infinite/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
