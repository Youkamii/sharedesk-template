import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

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
