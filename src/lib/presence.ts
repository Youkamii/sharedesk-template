import { getAdapter } from "@/lib/storage";
import {
  type StorageAdapter,
  StorageError,
} from "@/lib/storage/types";

const FILE = "presence.json";
const FILE_VERSION = 1;
const MAX_CAS_ATTEMPTS = 8;
const MAX_ACTIVE_LEASES = 5_000;
const MAX_PARTICIPANT_ID_LENGTH = 256;
const MAX_SESSION_LEASE_ID_LENGTH = 128;
const MAX_LEASE_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 160;
const MAX_TRANSFERS_PER_LEASE = 100;
const MAX_TRANSFER_ID_LENGTH = 256;
const MAX_TRANSFER_NAME_LENGTH = 255;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const PRESENCE_ACTIVE_MS = 90 * 1_000;
export const PRESENCE_TRANSFER_ACTIVE_MS = 15 * 1_000;

const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface PresenceTransferInput {
  id: string;
  kind: "upload" | "download";
  name: string;
  transferred: number;
  total: number | null;
}

export interface PresenceTransfer extends PresenceTransferInput {
  updatedAt: number;
}

interface PresenceLease {
  participantId: string;
  leaseId: string;
  name: string;
  lastSeenAt: number;
  transfers?: PresenceTransfer[];
}

interface PresenceFile {
  version: 1;
  leases: PresenceLease[];
}

export interface PresenceIdentity {
  participantId: string;
  leaseId: string;
  name: string;
  transfers?: PresenceTransferInput[];
}

export interface PresenceMember {
  name: string;
  isSelf: boolean;
  transfers: PresenceTransfer[];
}

export interface PresenceSnapshot {
  count: number;
  members: PresenceMember[];
  activeWindowMs: number;
}

function emptyFile(): PresenceFile {
  return { version: FILE_VERSION, leases: [] };
}

export function presenceTabLeaseId(
  sessionLeaseId: string,
  tabId: unknown,
): string {
  if (
    !sessionLeaseId ||
    sessionLeaseId.length > MAX_SESSION_LEASE_ID_LENGTH ||
    typeof tabId !== "string" ||
    !TAB_ID_PATTERN.test(tabId)
  ) {
    throw new StorageError("BAD_ID", "탭 정보가 올바르지 않습니다");
  }
  return `${sessionLeaseId}:tab:${tabId}`;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertTransferInput(value: unknown): PresenceTransferInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageError("BAD_ID", "전송 상태가 올바르지 않습니다");
  }
  const candidate = value as Partial<PresenceTransferInput>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name =
    typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (
    !id ||
    id.length > MAX_TRANSFER_ID_LENGTH ||
    (candidate.kind !== "upload" && candidate.kind !== "download") ||
    !name ||
    name.length > MAX_TRANSFER_NAME_LENGTH ||
    !isSafeNonNegativeInteger(candidate.transferred) ||
    (candidate.total !== null &&
      (!isSafeNonNegativeInteger(candidate.total) ||
        candidate.transferred > candidate.total))
  ) {
    throw new StorageError("BAD_ID", "전송 상태가 올바르지 않습니다");
  }
  return {
    id,
    kind: candidate.kind,
    name,
    transferred: candidate.transferred,
    total: candidate.total,
  };
}

function assertTransfers(value: unknown): PresenceTransferInput[] {
  if (!Array.isArray(value) || value.length > MAX_TRANSFERS_PER_LEASE) {
    throw new StorageError("BAD_ID", "전송 상태가 올바르지 않습니다");
  }
  return value.map(assertTransferInput);
}

function normalizeStoredTransfers(value: unknown): PresenceTransfer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TRANSFERS_PER_LEASE) {
    throw new StorageError("UPSTREAM", "접속 인원 상태가 손상되었습니다");
  }
  return value.map((candidate) => {
    let transfer: PresenceTransferInput;
    try {
      transfer = assertTransferInput(candidate);
    } catch {
      throw new StorageError("UPSTREAM", "접속 인원 상태가 손상되었습니다");
    }
    const updatedAt = (candidate as Partial<PresenceTransfer>).updatedAt;
    if (!isSafeNonNegativeInteger(updatedAt)) {
      throw new StorageError("UPSTREAM", "접속 인원 상태가 손상되었습니다");
    }
    return { ...transfer, updatedAt };
  });
}

function assertIdentity(identity: PresenceIdentity): PresenceIdentity {
  const participantId = identity.participantId.trim();
  const leaseId = identity.leaseId.trim();
  const name = identity.name.trim() || "이름 없음";
  if (
    !participantId ||
    participantId.length > MAX_PARTICIPANT_ID_LENGTH ||
    !leaseId ||
    leaseId.length > MAX_LEASE_ID_LENGTH
  ) {
    throw new StorageError("BAD_ID", "접속 사용자 정보가 올바르지 않습니다");
  }
  return {
    participantId,
    leaseId,
    name: name.slice(0, MAX_NAME_LENGTH),
    ...(identity.transfers === undefined
      ? {}
      : { transfers: assertTransfers(identity.transfers) }),
  };
}

function normalize(raw: unknown): PresenceFile {
  if (raw === null) return emptyFile();
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as Partial<PresenceFile>).version !== FILE_VERSION ||
    !Array.isArray((raw as Partial<PresenceFile>).leases)
  ) {
    throw new StorageError("UPSTREAM", "접속 인원 상태가 손상되었습니다");
  }

  const latestByLease = new Map<string, PresenceLease>();
  for (const candidate of (raw as PresenceFile).leases) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.participantId !== "string" ||
      !candidate.participantId ||
      candidate.participantId.length > MAX_PARTICIPANT_ID_LENGTH ||
      typeof candidate.leaseId !== "string" ||
      !candidate.leaseId ||
      candidate.leaseId.length > MAX_LEASE_ID_LENGTH ||
      typeof candidate.name !== "string" ||
      !candidate.name ||
      candidate.name.length > MAX_NAME_LENGTH ||
      !isSafeNonNegativeInteger(candidate.lastSeenAt)
    ) {
      throw new StorageError("UPSTREAM", "접속 인원 상태가 손상되었습니다");
    }
    const lease: PresenceLease = {
      participantId: candidate.participantId,
      leaseId: candidate.leaseId,
      name: candidate.name,
      lastSeenAt: candidate.lastSeenAt,
      ...(candidate.transfers === undefined
        ? {}
        : { transfers: normalizeStoredTransfers(candidate.transfers) }),
    };
    const previous = latestByLease.get(candidate.leaseId);
    if (!previous || previous.lastSeenAt < lease.lastSeenAt) {
      latestByLease.set(candidate.leaseId, lease);
    }
  }
  return { version: FILE_VERSION, leases: [...latestByLease.values()] };
}

function activeLeases(file: PresenceFile, now: number): PresenceLease[] {
  const cutoff = now - PRESENCE_ACTIVE_MS;
  return file.leases
    .filter(
      (entry) =>
        entry.lastSeenAt >= cutoff && entry.lastSeenAt <= now + CLOCK_SKEW_MS,
    )
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_ACTIVE_LEASES);
}

function snapshot(
  file: PresenceFile,
  selfParticipantId: string,
  now: number,
): PresenceSnapshot {
  const participants = new Map<
    string,
    { latest: PresenceLease; transfers: PresenceTransfer[] }
  >();
  const transferCutoff = now - PRESENCE_TRANSFER_ACTIVE_MS;
  for (const lease of activeLeases(file, now)) {
    const currentTransfers = (lease.transfers ?? []).filter(
      (transfer) =>
        transfer.updatedAt >= transferCutoff &&
        transfer.updatedAt <= now + CLOCK_SKEW_MS,
    );
    const participant = participants.get(lease.participantId);
    if (participant) {
      participant.transfers.push(...currentTransfers);
    } else {
      participants.set(lease.participantId, {
        latest: lease,
        transfers: currentTransfers,
      });
    }
  }
  const active = [...participants.entries()].sort((a, b) => {
    if (a[0] === selfParticipantId) return -1;
    if (b[0] === selfParticipantId) return 1;
    return a[1].latest.name.localeCompare(b[1].latest.name, "ko-KR");
  });
  return {
    count: active.length,
    members: active.map(([participantId, participant]) => ({
      name: participant.latest.name,
      isSelf: participantId === selfParticipantId,
      transfers: participant.transfers.sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    })),
    activeWindowMs: PRESENCE_ACTIVE_MS,
  };
}

function isConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "CONFLICT"
  );
}

async function mutatePresence(
  identity: PresenceIdentity,
  now: number,
  keepSelf: boolean,
  adapter: StorageAdapter,
  removeLeaseGroup = false,
): Promise<PresenceSnapshot> {
  const clean = assertIdentity(identity);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const before = await adapter.readStateVersioned<unknown>(FILE);
    const current = normalize(before.value);
    const previousSelf = current.leases.find(
      (lease) => lease.leaseId === clean.leaseId,
    );
    const tabLeasePrefix = `${clean.leaseId}:tab:`;
    const leases = activeLeases(current, now).filter((lease) => {
      if (lease.leaseId === clean.leaseId) return false;
      return !(removeLeaseGroup && lease.leaseId.startsWith(tabLeasePrefix));
    });
    if (keepSelf) {
      const heartbeatIsNewer = (previousSelf?.lastSeenAt ?? -1) <= now;
      if (!heartbeatIsNewer && previousSelf) {
        leases.push(previousSelf);
      } else {
        leases.push({
          participantId: clean.participantId,
          leaseId: clean.leaseId,
          name: clean.name,
          lastSeenAt: now,
          transfers:
            clean.transfers === undefined
              ? previousSelf?.transfers
              : clean.transfers.map((transfer) => ({
                  ...transfer,
                  updatedAt: now,
                })),
        });
      }
    }
    const next: PresenceFile = {
      version: FILE_VERSION,
      leases: leases
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, MAX_ACTIVE_LEASES),
    };
    try {
      await adapter.compareAndSwapState(FILE, next, before.version);
      return snapshot(next, clean.participantId, now);
    } catch (error) {
      if (isConflict(error)) continue;
      throw error;
    }
  }
  throw new StorageError(
    "CONFLICT",
    "접속 인원이 동시에 바뀌었습니다. 잠시 후 다시 시도해 주세요",
  );
}

export async function listPresence(
  selfParticipantId: string,
  now = Date.now(),
  adapter: StorageAdapter = getAdapter(),
): Promise<PresenceSnapshot> {
  const current = normalize(
    (await adapter.readStateVersioned<unknown>(FILE)).value,
  );
  return snapshot(current, selfParticipantId, now);
}

export async function touchPresence(
  identity: PresenceIdentity,
  now = Date.now(),
  adapter: StorageAdapter = getAdapter(),
): Promise<PresenceSnapshot> {
  return mutatePresence(identity, now, true, adapter);
}

export async function leavePresence(
  identity: PresenceIdentity,
  now = Date.now(),
  adapter: StorageAdapter = getAdapter(),
): Promise<PresenceSnapshot> {
  return mutatePresence(identity, now, false, adapter);
}

export async function leavePresenceGroup(
  identity: PresenceIdentity,
  now = Date.now(),
  adapter: StorageAdapter = getAdapter(),
): Promise<PresenceSnapshot> {
  return mutatePresence(identity, now, false, adapter, true);
}
