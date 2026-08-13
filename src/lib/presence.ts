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
const MAX_LEASE_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 160;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const PRESENCE_ACTIVE_MS = 90 * 1_000;

interface PresenceLease {
  participantId: string;
  leaseId: string;
  name: string;
  lastSeenAt: number;
}

interface PresenceFile {
  version: 1;
  leases: PresenceLease[];
}

export interface PresenceIdentity {
  participantId: string;
  leaseId: string;
  name: string;
}

export interface PresenceMember {
  name: string;
  isSelf: boolean;
}

export interface PresenceSnapshot {
  count: number;
  members: PresenceMember[];
  activeWindowMs: number;
}

function emptyFile(): PresenceFile {
  return { version: FILE_VERSION, leases: [] };
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
  return { participantId, leaseId, name: name.slice(0, MAX_NAME_LENGTH) };
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
      !Number.isSafeInteger(candidate.lastSeenAt) ||
      candidate.lastSeenAt < 0
    ) {
      throw new StorageError("UPSTREAM", "접속 인원 상태가 손상되었습니다");
    }
    const previous = latestByLease.get(candidate.leaseId);
    if (!previous || previous.lastSeenAt < candidate.lastSeenAt) {
      latestByLease.set(candidate.leaseId, { ...candidate });
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
  const participants = new Map<string, PresenceLease>();
  for (const lease of activeLeases(file, now)) {
    if (!participants.has(lease.participantId)) {
      participants.set(lease.participantId, lease);
    }
  }
  const active = [...participants.values()].sort((a, b) => {
    if (a.participantId === selfParticipantId) return -1;
    if (b.participantId === selfParticipantId) return 1;
    return a.name.localeCompare(b.name, "ko-KR");
  });
  return {
    count: active.length,
    members: active.map((entry) => ({
      name: entry.name,
      isSelf: entry.participantId === selfParticipantId,
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
): Promise<PresenceSnapshot> {
  const clean = assertIdentity(identity);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const before = await adapter.readStateVersioned<unknown>(FILE);
    const current = normalize(before.value);
    const previousSelf = current.leases.find(
      (lease) => lease.leaseId === clean.leaseId,
    );
    const leases = activeLeases(current, now).filter(
      (lease) => lease.leaseId !== clean.leaseId,
    );
    if (keepSelf) {
      const heartbeatIsNewer = (previousSelf?.lastSeenAt ?? -1) <= now;
      leases.push({
        ...clean,
        name: heartbeatIsNewer ? clean.name : previousSelf!.name,
        lastSeenAt: Math.max(previousSelf?.lastSeenAt ?? 0, now),
      });
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
  const current = normalize((await adapter.readStateVersioned<unknown>(FILE)).value);
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
