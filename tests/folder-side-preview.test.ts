import assert from "node:assert/strict";
import test from "node:test";
import {
  adjacentFolderImagePreviewKey,
  folderImagePreviewEntries,
} from "../src/lib/client/folder-side-preview";

const entries = [
  {
    layoutKey: "folder",
    name: "사진",
    isFolder: true,
    mimeType: "application/vnd.google-apps.folder",
  },
  {
    layoutKey: "first",
    name: "첫 사진.png",
    isFolder: false,
    mimeType: "image/png",
  },
  {
    layoutKey: "text",
    name: "설명.txt",
    isFolder: false,
    mimeType: "text/plain",
  },
  {
    layoutKey: "second",
    name: "움직이는 사진.gif",
    isFolder: false,
    mimeType: "image/gif",
  },
];

test("폴더 우측 미리보기는 이미지와 GIF만 원래 순서대로 고른다", () => {
  assert.deepEqual(
    folderImagePreviewEntries(entries).map((entry) => entry.layoutKey),
    ["first", "second"],
  );
});

test("방향키 탐색은 인접 이미지로 이동하고 양 끝에서는 멈춘다", () => {
  assert.equal(adjacentFolderImagePreviewKey(entries, "first", 1), "second");
  assert.equal(adjacentFolderImagePreviewKey(entries, "second", -1), "first");
  assert.equal(adjacentFolderImagePreviewKey(entries, "first", -1), null);
  assert.equal(adjacentFolderImagePreviewKey(entries, "second", 1), null);
  assert.equal(adjacentFolderImagePreviewKey(entries, "missing", 1), "first");
});
