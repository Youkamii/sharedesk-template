import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutoDismissNoticeController,
  NOTICE_DURATION_MS,
  type NoticeOccurrence,
  type NoticeTimeoutScheduler,
} from "../src/lib/client/use-auto-dismiss-notice";

class FakeClock implements NoticeTimeoutScheduler {
  now = 0;
  nextId = 1;
  tasks = new Map<number, { callback: () => void; dueAt: number }>();

  set(callback: () => void, durationMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { callback, dueAt: this.now + durationMs });
    return id;
  }

  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(durationMs: number): void {
    const target = this.now + durationMs;

    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (!next) break;

      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.dueAt;
      task.callback();
    }

    this.now = target;
  }
}

function occurrence(
  id: number,
  message: string,
  durationMs: number = NOTICE_DURATION_MS.default,
): NoticeOccurrence {
  return { id, message, durationMs };
}

test("일반 알림은 4초, 오류 알림은 호출자가 고른 8초 뒤 닫힌다", () => {
  const clock = new FakeClock();
  const dismissed: number[] = [];
  const controller = createAutoDismissNoticeController(
    (id) => dismissed.push(id),
    clock,
  );

  controller.update(occurrence(1, "저장했습니다"));
  clock.advance(NOTICE_DURATION_MS.default - 1);
  assert.deepEqual(dismissed, []);
  clock.advance(1);
  assert.deepEqual(dismissed, [1]);

  controller.update(occurrence(2, "저장하지 못했습니다", NOTICE_DURATION_MS.error));
  clock.advance(NOTICE_DURATION_MS.error - 1);
  assert.deepEqual(dismissed, [1]);
  clock.advance(1);
  assert.deepEqual(dismissed, [1, 2]);
});

test("새 알림은 이전 타이머를 없애고 자신의 시간부터 다시 센다", () => {
  const clock = new FakeClock();
  const dismissed: number[] = [];
  const controller = createAutoDismissNoticeController(
    (id) => dismissed.push(id),
    clock,
  );

  controller.update(occurrence(1, "첫 알림"));
  clock.advance(3_000);
  controller.update(occurrence(2, "새 알림"));

  assert.equal(clock.tasks.size, 1);
  clock.advance(1_000);
  assert.deepEqual(dismissed, []);
  clock.advance(2_999);
  assert.deepEqual(dismissed, []);
  clock.advance(1);
  assert.deepEqual(dismissed, [2]);
});

test("같은 문구도 서로 다른 발생 ID면 새 알림으로 다시 시작한다", () => {
  const clock = new FakeClock();
  const dismissed: number[] = [];
  const controller = createAutoDismissNoticeController(
    (id) => dismissed.push(id),
    clock,
  );

  controller.update(occurrence(7, "저장했습니다"));
  clock.advance(3_500);
  controller.update(occurrence(8, "저장했습니다"));
  clock.advance(500);
  assert.deepEqual(dismissed, []);
  clock.advance(3_500);
  assert.deepEqual(dismissed, [8]);
});

test("null 알림과 clear는 남은 타이머를 제거한다", () => {
  const clock = new FakeClock();
  const dismissed: number[] = [];
  const controller = createAutoDismissNoticeController(
    (id) => dismissed.push(id),
    clock,
  );

  controller.update(null);
  assert.equal(clock.tasks.size, 0);

  controller.update(occurrence(1, "곧 닫힘"));
  controller.update(null);
  assert.equal(clock.tasks.size, 0);
  clock.advance(NOTICE_DURATION_MS.default);
  assert.deepEqual(dismissed, []);

  controller.update(occurrence(2, "컴포넌트 종료"));
  controller.clear();
  assert.equal(clock.tasks.size, 0);
  clock.advance(NOTICE_DURATION_MS.default);
  assert.deepEqual(dismissed, []);
});
