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
  assert.match(readme, /\| Dawn \| Night tide \|/);
  assert.match(
    readme,
    /!\[Dawn wallpaper\]\(\.\/docs\/sharedesk-wallpaper-dawn\.png\)/,
  );
  assert.match(koReadme, /\| 여명 \| 밤바다 \|/);
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
