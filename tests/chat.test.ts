import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("데스크 채팅은 Drive 상태에 메시지를 충돌 없이 이어 쓴다", async () => {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-chat-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;

  try {
    const chat = await import("../src/lib/chat");
    assert.equal(chat.normalizeChatText("  안녕\r\n  "), "안녕");
    assert.equal(chat.normalizeChatText("   "), null);
    assert.equal(
      chat.normalizeChatText("가".repeat(chat.CHAT_MAX_TEXT_LENGTH + 1)),
      null,
    );

    const first = await chat.sendChatMessage({
      userId: "user-1",
      name: "첫 사용자",
      text: "첫 메시지",
    });
    const sent = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        chat.sendChatMessage({
          userId: `user-${index + 2}`,
          name: `사용자 ${index + 2}`,
          text: `메시지 ${index + 2}`,
        }),
      ),
    );
    const all = await chat.listChatMessages();
    assert.equal(all.length, 6);
    assert.deepEqual(
      new Set(all.map((message) => message.id)),
      new Set([first.id, ...sent.map((message) => message.id)]),
    );
    const afterFirst = await chat.listChatMessages(first.id);
    assert.equal(afterFirst.some((message) => message.id === first.id), false);
    assert.equal(afterFirst.length, 5);

    const { getAdapter } = await import("../src/lib/storage");
    const retained = Array.from({ length: 500 }, (_, index) => ({
      id: `message-${index}`,
      userId: `user-${index}`,
      name: `사용자 ${index}`,
      text: `메시지 ${index}`,
      createdAt: new Date(Date.now() - (500 - index) * 1000).toISOString(),
    }));
    await getAdapter().writeState("chat.json", {
      version: 1,
      messages: retained,
    });
    assert.equal((await chat.listChatMessages("missing-cursor")).length, 500);
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("채팅 API와 창은 서버리스 폴링·독립 버튼·새 메시지 알림을 사용한다", async () => {
  const [route, panel, filesView, css] = await Promise.all([
    readFile(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/ChatPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/desktop.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireSession\(\)/);
  assert.match(route, /auth\.session\.isGuest/);
  assert.match(route, /sendChatMessage/);
  assert.match(route, /cursor: messages\.at\(-1\)\?\.id/);
  assert.doesNotMatch(route, /WebSocket|EventSource/);
  assert.match(panel, /ACTIVE_POLL_MS = 4_000/);
  assert.match(panel, /IDLE_POLL_MS = 60_000/);
  assert.match(panel, /MINIMIZED_POLL_MS = 5 \* 60_000/);
  assert.match(panel, /document\.hidden/);
  assert.match(panel, /knownIdsRef/);
  assert.match(panel, /aria-label=\{t\("최소화"\)\}/);
  assert.doesNotMatch(panel, /aria-label=\{.*"최대화"/);
  assert.match(filesView, /useState\(\{ minimized: true, z: 0 \}\)/);
  assert.doesNotMatch(filesView, /role="menuitem" onClick=\{openChatWindow\}/);
  assert.match(filesView, /styles\.chatTaskUnread/);
  assert.match(filesView, /styles\.chatUnreadBadge/);
  assert.match(css, /@keyframes chatTaskBlink/);
  assert.match(filesView, /\{t\("추가기능"\)\}/);
});
