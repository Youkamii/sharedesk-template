import { randomUUID } from "node:crypto";
import {
  publicFolderAtFolderId,
  type PublicFolder,
} from "@/lib/public-folders";
import { getAdapter } from "@/lib/storage";
import { StorageError, type Entry, type StorageUsage } from "@/lib/storage/types";
import { getDeskSettings, type DeskSettings } from "@/lib/users";

const FILE = "upload-reservations.json";
const MAX_RESERVATIONS = 500;
const PROXY_RESERVATION_TTL_MS = 60 * 60 * 1000;
const DIRECT_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const MAX_COMPLETED_UPLOADS = 1_000;

// 공개 폴더(#10)의 외부인 업로드가 쓰는 합성 userId 접두사. 예약 정산이
// userId 일치를 요구하므로 세션 없는 업로드에 이 규약을 쓴다.
export const PUBLIC_UPLOADER_PREFIX = "public:";
// 무세션 외부인이 예약만 쌓아 데스크 전역 자원(MAX_RESERVATIONS·예약
// 바이트)을 잠식하지 못하게, 공개 업로드는 폴더당 동시 예약을 좁게 묶는다.
const MAX_PUBLIC_RESERVATIONS_PER_FOLDER = 4;

export interface UploadReservation {
  id: string;
  userId: string;
  parentId: string;
  name: string;
  size: number;
  transport: "direct" | "proxy";
  claimedAt: string | null;
  expiresAt: string;
}

interface ReservationFile {
  version: 3;
  reservations: UploadReservation[];
  completedUploads: Array<{ fileId: string; expiresAt: string }>;
}

export interface StorageStatus extends StorageUsage {
  maxUploadBytes: number | null;
  deskStorageLimitBytes: number | null;
  reservedBytes: number;
}

function normalize(value: unknown, now = Date.now()): ReservationFile {
  const raw = value as {
    reservations?: unknown;
    completedUploads?: unknown;
  } | null;
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
            (entry.transport === "direct" || entry.transport === "proxy") &&
            (entry.claimedAt === null ||
              (typeof entry.claimedAt === "string" &&
                Number.isFinite(Date.parse(entry.claimedAt)))) &&
            typeof entry.expiresAt === "string" &&
            Date.parse(entry.expiresAt) > now
          );
        })
        .slice(0, MAX_RESERVATIONS)
    : [];
  const completedUploads = Array.isArray(raw?.completedUploads)
    ? raw.completedUploads
        .filter((item): item is { fileId: string; expiresAt: string } => {
          const completed = item as {
            fileId?: unknown;
            expiresAt?: unknown;
          } | null;
          return (
            !!completed &&
            typeof completed.fileId === "string" &&
            completed.fileId.length > 0 &&
            typeof completed.expiresAt === "string" &&
            Date.parse(completed.expiresAt) > now
          );
        })
        .slice(-MAX_COMPLETED_UPLOADS)
    : [];
  return { version: 3, reservations, completedUploads };
}

function reservationTtl(transport: UploadReservation["transport"]): number {
  return transport === "direct"
    ? DIRECT_RESERVATION_TTL_MS
    : PROXY_RESERVATION_TTL_MS;
}

// 공개 폴더의 폴더별 상한 판정. 초과 사유 문구를 돌려주고, 통과면 null.
// reserveUpload의 CAS 루프 안에서 시도마다 호출된다.
async function publicFolderLimitError(
  adapter: ReturnType<typeof getAdapter>,
  folder: PublicFolder,
  reservations: UploadReservation[],
  input: { parentId: string; userId: string },
  size: number,
): Promise<string | null> {
  const parentReservations = reservations.filter(
    (reservation) => reservation.parentId === input.parentId,
  );
  // 무세션 외부인은 폴더당 동시 예약을 좁게 묶는다 — 큰 size를 선언만
  // 하고 본문을 흘리지 않는 방식으로 데스크 전역 예약 자원을 잠식하는
  // 것을 막는다. 멤버 업로드는 세션 userId라 이 상한을 받지 않는다.
  if (input.userId.startsWith(PUBLIC_UPLOADER_PREFIX)) {
    const publicActive = parentReservations.filter((reservation) =>
      reservation.userId.startsWith(PUBLIC_UPLOADER_PREFIX),
    ).length;
    if (publicActive >= MAX_PUBLIC_RESERVATIONS_PER_FOLDER) {
      return "공개 폴더에 진행 중인 업로드가 많습니다. 잠시 후 다시 시도해 주세요";
    }
  }
  if (folder.maxFiles === null && folder.maxTotalBytes === null) return null;
  const children = await adapter.list(input.parentId);
  if (folder.maxFiles !== null) {
    const usedFiles = children.filter((child) => !child.isFolder).length;
    if (usedFiles + parentReservations.length + 1 > folder.maxFiles) {
      return "공개 폴더의 파일 개수 한도를 넘었습니다";
    }
  }
  if (folder.maxTotalBytes !== null) {
    const usedBytes = children.reduce(
      (total, child) => total + (child.size ?? 0),
      0,
    );
    const reservedBytes = parentReservations.reduce(
      (total, reservation) => total + reservation.size,
      0,
    );
    if (usedBytes + reservedBytes + size > folder.maxTotalBytes) {
      return "공개 폴더의 저장 용량 한도를 넘었습니다";
    }
  }
  return null;
}

function validateSize(
  size: unknown,
  settings: DeskSettings,
  enforceMaxUpload: boolean,
): number {
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new StorageError("BAD_ID", "파일 크기를 확인해 주세요");
  }
  const bytes = size as number;
  if (
    enforceMaxUpload &&
    settings.maxUploadBytes !== null &&
    bytes > settings.maxUploadBytes
  ) {
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
  transport: UploadReservation["transport"];
  enforceMaxUpload?: boolean;
}): Promise<string | null> {
  const settings = await getDeskSettings({ fresh: true });
  const size = validateSize(
    input.size,
    settings,
    input.enforceMaxUpload !== false,
  );

  // 공개 폴더(#10)의 폴더별 상한은 여기서 무조건 집행한다 — 외부인 공개
  // 라우트든 멤버의 기존 업로드 라우트든 같은 parentId면 같은 계약이다.
  // (예외: drive/content의 .txt 증가분 예약은 parentId가 파일 id라 여기
  // 걸리지 않는다 — editor 전용 경로라 데스크 한도로만 다스린다.)
  const publicFolder = await publicFolderAtFolderId(input.parentId);
  if (publicFolder?.maxFileBytes != null && size > publicFolder.maxFileBytes) {
    throw new StorageError(
      "CONFLICT",
      "공개 폴더의 파일 크기 한도를 넘었습니다",
    );
  }

  // 데스크 한도도 폴더 상한도 없으면 예약할 것이 없다. 공개 폴더는 상한이
  // 전부 비어 있어도 예약을 만들어 동시 업로드 남용(아래 폴더당 상한)을
  // 계속 추적한다.
  if (settings.deskStorageLimitBytes === null && !publicFolder) return null;

  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // 예약 장부를 먼저 읽고 실제 사용량을 확인한 뒤 그 버전으로 CAS한다.
    // 사이에 다른 업로드가 예약을 끝내면 CAS가 충돌해 새 사용량부터 다시 읽는다.
    const state = await adapter.readStateVersioned<ReservationFile>(FILE);
    const file = normalize(state.value);
    if (settings.deskStorageLimitBytes !== null) {
      const usage = await adapter.getStorageUsage();
      const reservedBytes = file.reservations.reduce(
        (total, reservation) => total + reservation.size,
        0,
      );
      if (
        usage.deskUsedBytes + reservedBytes + size >
        settings.deskStorageLimitBytes
      ) {
        const confirmed =
          await adapter.readStateVersioned<ReservationFile>(FILE);
        if (confirmed.version !== state.version) continue;
        throw new StorageError(
          "CONFLICT",
          "이 데스크에 남은 저장 용량이 부족합니다",
        );
      }
    }
    if (publicFolder) {
      // 폴더 사용량은 매 시도마다 다시 실측한다(직계 합산 — 평평 유지
      // 전제). 데스크 전역 판정과 같은 원자성: 다른 업로드가 예약을
      // 끝내면 장부 CAS가 충돌해 새 실측부터 다시 읽는다. upload 완료와
      // finish 사이의 한순간은 파일·예약이 이중으로 세어질 수 있는데,
      // 상한을 넘겨 통과시키는 방향이 아니라 일시적으로 더 엄격해지는
      // 방향이라 그대로 둔다.
      const rejected = await publicFolderLimitError(
        adapter,
        publicFolder,
        file.reservations,
        input,
        size,
      );
      if (rejected) {
        const confirmed =
          await adapter.readStateVersioned<ReservationFile>(FILE);
        if (confirmed.version !== state.version) continue;
        throw new StorageError("CONFLICT", rejected);
      }
    }
    if (file.reservations.length >= MAX_RESERVATIONS) {
      throw new StorageError(
        "CONFLICT",
        "진행 중인 업로드가 너무 많습니다. 잠시 후 다시 시도해 주세요",
      );
    }
    const id = randomUUID();
    const next: ReservationFile = {
      version: 3,
      reservations: [
        ...file.reservations,
        {
          id,
          userId: input.userId,
          parentId: input.parentId,
          name: input.name,
          size,
          transport: input.transport,
          claimedAt: null,
          expiresAt: new Date(
            Date.now() + reservationTtl(input.transport),
          ).toISOString(),
        },
      ],
      completedUploads: file.completedUploads,
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

export async function claimUploadReservation(
  id: string,
  userId: string,
  expected: {
    parentId: string;
    name: string;
    size: number;
    transport: UploadReservation["transport"];
  },
): Promise<UploadReservation | null> {
  const adapter = getAdapter();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ReservationFile>(FILE);
    const file = normalize(state.value);
    const reservation = file.reservations.find(
      (item) => item.id === id && item.userId === userId,
    );
    if (
      !reservation ||
      reservation.claimedAt !== null ||
      reservation.parentId !== expected.parentId ||
      reservation.name !== expected.name ||
      reservation.size !== expected.size ||
      reservation.transport !== expected.transport
    ) {
      return null;
    }
    const claimed: UploadReservation = {
      ...reservation,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + reservationTtl(reservation.transport),
      ).toISOString(),
    };
    try {
      await adapter.compareAndSwapState(
        FILE,
        {
          version: 3,
          reservations: file.reservations.map((item) =>
            item.id === id ? claimed : item,
          ),
          completedUploads: file.completedUploads,
        } satisfies ReservationFile,
        state.version,
      );
      return claimed;
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "CONFLICT") {
        throw error;
      }
    }
  }
  throw new StorageError("CONFLICT", "업로드 예약을 다시 시도해 주세요");
}

export async function renewUploadReservation(
  id: string,
  userId: string,
): Promise<boolean> {
  const adapter = getAdapter();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ReservationFile>(FILE);
    const file = normalize(state.value);
    const reservation = file.reservations.find(
      (item) =>
        item.id === id &&
        item.userId === userId &&
        item.transport === "direct" &&
        item.claimedAt === null,
    );
    if (!reservation) return false;
    try {
      await adapter.compareAndSwapState(
        FILE,
        {
          version: 3,
          reservations: file.reservations.map((item) =>
            item.id === id
              ? {
                  ...item,
                  expiresAt: new Date(
                    Date.now() + DIRECT_RESERVATION_TTL_MS,
                  ).toISOString(),
                }
              : item,
          ),
          completedUploads: file.completedUploads,
        } satisfies ReservationFile,
        state.version,
      );
      return true;
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "CONFLICT") {
        throw error;
      }
    }
  }
  throw new StorageError("CONFLICT", "업로드 예약 갱신을 다시 시도해 주세요");
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
  options: { ignoreEntryName?: boolean } = {},
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
    if (entry) {
      if (
        entry.isFolder ||
        entry.size === null ||
        entry.size !== reservation.size ||
        (options.ignoreEntryName !== true && entry.name !== reservation.name)
      ) {
        throw new StorageError(
          "CONFLICT",
          "업로드된 파일 정보가 일치하지 않습니다",
        );
      }
      if (
        file.completedUploads.some(
          (completed) => completed.fileId === entry.id,
        )
      ) {
        throw new StorageError(
          "CONFLICT",
          "이미 완료 처리한 업로드 파일입니다",
        );
      }
    }
    try {
      await adapter.compareAndSwapState(
        FILE,
        {
          version: 3,
          reservations: file.reservations.filter((item) => item.id !== id),
          completedUploads: entry
            ? [
                ...file.completedUploads,
                {
                  fileId: entry.id,
                  expiresAt: new Date(
                    Date.now() + DIRECT_RESERVATION_TTL_MS,
                  ).toISOString(),
                },
              ].slice(-MAX_COMPLETED_UPLOADS)
            : file.completedUploads,
        } satisfies ReservationFile,
        state.version,
      );
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
    getAdapter().getStorageUsage(),
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

export function parseUploadContentLength(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) {
    throw new StorageError("BAD_ID", "파일 크기를 확인해 주세요");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new StorageError("BAD_ID", "파일 크기를 확인해 주세요");
  }
  return size;
}

// 프록시 업로드는 Content-Length만 예약하고 더 큰 chunked 본문을 흘리면
// 용량 제한을 우회할 수 있다. 저장소에 전달되는 스트림 자체를 선언 크기에 묶는다.
export function exactSizeUploadStream(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          if (received !== expectedSize) {
            controller.error(
              new StorageError("CONFLICT", "업로드된 파일 크기가 일치하지 않습니다"),
            );
          } else {
            controller.close();
          }
          return;
        }
        received += chunk.value.byteLength;
        if (received > expectedSize) {
          await reader.cancel("upload size mismatch").catch(() => undefined);
          release();
          controller.error(
            new StorageError("CONFLICT", "업로드된 파일 크기가 일치하지 않습니다"),
          );
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      release();
    },
  });
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
