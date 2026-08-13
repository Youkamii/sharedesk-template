import { useCallback, useEffect, useRef, useState } from "react";

export const NOTICE_DURATION_MS = {
  default: 4_000,
  error: 8_000,
} as const;

export type SetAutoDismissNotice = (
  message: string | null,
  durationMs?: number,
) => void;

export type NoticeOccurrence = {
  id: number;
  message: string;
  durationMs: number;
};

export type NoticeTimeoutScheduler = {
  set(callback: () => void, durationMs: number): unknown;
  clear(handle: unknown): void;
};

export type AutoDismissNoticeController = {
  update(notice: NoticeOccurrence | null): void;
  clear(): void;
};

const systemScheduler: NoticeTimeoutScheduler = {
  set: (callback, durationMs) => globalThis.setTimeout(callback, durationMs),
  clear: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createAutoDismissNoticeController(
  onDismiss: (id: number) => void,
  scheduler: NoticeTimeoutScheduler = systemScheduler,
): AutoDismissNoticeController {
  let active: { handle: unknown; token: object } | null = null;

  const clear = () => {
    if (!active) return;
    scheduler.clear(active.handle);
    active = null;
  };

  return {
    update(notice) {
      clear();
      if (!notice) return;

      const token = {};
      const handle = scheduler.set(() => {
        if (active?.token !== token) return;
        active = null;
        onDismiss(notice.id);
      }, notice.durationMs);
      active = { handle, token };
    },
    clear,
  };
}

export function useAutoDismissNotice(
  defaultDurationMs = NOTICE_DURATION_MS.default,
): readonly [string | null, SetAutoDismissNotice] {
  const nextId = useRef(0);
  const [notice, setNoticeState] = useState<NoticeOccurrence | null>(null);

  const setNotice = useCallback<SetAutoDismissNotice>(
    (message, durationMs = defaultDurationMs) => {
      if (message === null) {
        setNoticeState(null);
        return;
      }

      nextId.current += 1;
      setNoticeState({ id: nextId.current, message, durationMs });
    },
    [defaultDurationMs],
  );

  useEffect(() => {
    const controller = createAutoDismissNoticeController((id) => {
      setNoticeState((current) => (current?.id === id ? null : current));
    });
    controller.update(notice);
    return controller.clear;
  }, [notice]);

  return [notice?.message ?? null, setNotice] as const;
}
