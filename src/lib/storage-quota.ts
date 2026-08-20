import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/storage";
import { StorageError, type Entry, type StorageUsage } from "@/lib/storage/types";
import { getDeskSettings, type DeskSettings } from "@/lib/users";

const FILE = "upload-reservations.json";
const MAX_RESERVATIONS = 500;
const RESERVATION_TTL_MS = 60 * 60 * 1000;
const USAGE_CACHE_MS = 15_000;
const MAX_ATTEMPTS = 4;

export interface UploadReservation {
  id: string;
  userId: string;
  parentId: string;
  name: string;
  size: number;
  expiresAt: string;
}

interface ReservationFile {
  version: 1;
  reservations: UploadReservation[];
}

export interface StorageStatus extends StorageUsage {
  maxUploadBytes: number | null;
  deskStorageLimitBytes: number | null;
  reservedBytes: number;
}

let usageCache: { at: number; usage: StorageUsage } | null = null;

function normalize(value: unknown, now = Date.now()): ReservationFile {
  const raw = value as { reservations?: unknown } | null;
  const reservations = Array.isArray(raw?.reservations)
    ? raw.reservations
        .filter((item): item is UploadReservation => {
          const entry = item as UploadReservation | null;
          return (
            !!entry &&
            typeof entry.id === "string" &&
            typeof entry.userId === "string" &&
            typeof entry.parentId === "string" &&
            typeof entry.name === "string" &&
            Number.isSafeInteger(entry.size) &&
            entry.size >= 0 &&
            typeof entry.expiresAt === "string" &&
            Date.parse(entry.expiresAt) > now
          );
        })
        .slice(0, MAX_RESERVATIONS)
    : [];
  return { version: 1, reservations };
}

async function readUsage(fresh = false): Promise<StorageUsage> {
  if (!fresh && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) {
    return usageCache.usage;
  }
  const usage = await getAdapter().getStorageUsage();
  usageCache = { at: Date.now(), usage };
  return usage;
}

function validateSize(size: unknown, settings: DeskSettings): number {
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new StorageError("BAD_ID", "파일 크기를 확인해 주세요");
  }
  const bytes = size as number;
  if (settings.maxUploadBytes !== null && bytes > settings.maxUploadBytes) {
    throw new StorageError(
      "CONFLICT",
      "한 번에 올릴 수 있는 파일 크기를 넘었습니다",
    );
  }
  return bytes;
}

export async function reserveUpload(input: {
  userId: string;
  parentId: string;
  name: string;
  size: unknown;
}): Promise<string | null> {
  const settings = await getDeskSettings({ fresh: true });
  const size = validateSize(input.size, settings);
  if (settings.deskStorageLimitBytes === null) return null;

  const usage = await readUsage();
  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ReservationFile>(FILE);
    const file = normalize(state.value);
    const reservedBytes = file.reservations.reduce(
      (total, reservation) => total + reservation.size,
      0,
    );
    if (
      usage.deskUsedBytes + reservedBytes + size >
      settings.deskStorageLimitBytes
    ) {
      throw new StorageError(
        "CONFLICT",
        "이 데스크에 남은 저장 용량이 부족합니다",
      );
    }
    if (file.reservations.length >= MAX_RESERVATIONS) {
      throw new StorageError(
        "CONFLICT",
        "진행 중인 업로드가 너무 많습니다. 잠시 후 다시 시도해 주세요",
      );
    }
    const id = randomUUID();
    const next: ReservationFile = {
      version: 1,
      reservations: [
        ...file.reservations,
        {
          id,
          userId: input.userId,
          parentId: input.parentId,
          name: input.name,
          size,
          expiresAt: new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
        },
      ],
    };
    try {
      await adapter.compareAndSwapState(FILE, next, state.version);
      return id;
    } catch (error) {
      lastError = error;
      if (!(error instanceof StorageError) || error.code !== "CONFLICT") throw error;
    }
  }
  throw lastError ?? new StorageError("CONFLICT", "업로드를 다시 시도해 주세요");
}

export async function getUploadReservation(
  id: string,
  userId: string,
): Promise<UploadReservation | null> {
  if (!id) return null;
  const state = await getAdapter().readState<ReservationFile>(FILE);
  return (
    normalize(state).reservations.find(
      (reservation) => reservation.id === id && reservation.userId === userId,
    ) ?? null
  );
}

export async function finishUploadReservation(
  id: string | null,
  userId: string,
  entry?: Entry,
): Promise<boolean> {
  if (!id) return true;
  const adapter = getAdapter();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ReservationFile>(FILE);
    const file = normalize(state.value);
    const reservation = file.reservations.find(
      (item) => item.id === id && item.userId === userId,
    );
    if (!reservation) return false;
    if (
      entry &&
      (entry.name !== reservation.name ||
        (entry.size !== null && entry.size !== reservation.size))
    ) {
      throw new StorageError("CONFLICT", "업로드된 파일 정보가 일치하지 않습니다");
    }
    try {
      await adapter.compareAndSwapState(
        FILE,
        {
          version: 1,
          reservations: file.reservations.filter((item) => item.id !== id),
        } satisfies ReservationFile,
        state.version,
      );
      usageCache = null;
      return true;
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "CONFLICT") throw error;
    }
  }
  throw new StorageError("CONFLICT", "업로드 완료 처리를 다시 시도해 주세요");
}

export async function getStorageStatus(fresh = false): Promise<StorageStatus> {
  const [settings, usage, reservationState] = await Promise.all([
    getDeskSettings({ fresh }),
    readUsage(fresh),
    getAdapter().readState<ReservationFile>(FILE),
  ]);
  const reservedBytes = normalize(reservationState).reservations.reduce(
    (total, reservation) => total + reservation.size,
    0,
  );
  return {
    ...usage,
    maxUploadBytes: settings.maxUploadBytes,
    deskStorageLimitBytes: settings.deskStorageLimitBytes,
    reservedBytes,
  };
}

export function uploadLimitError(
  size: unknown,
  settings: Pick<DeskSettings, "maxUploadBytes">,
): string | null {
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    return "파일 크기를 확인해 주세요";
  }
  return settings.maxUploadBytes !== null &&
    (size as number) > settings.maxUploadBytes
    ? "한 번에 올릴 수 있는 파일 크기를 넘었습니다"
    : null;
}
