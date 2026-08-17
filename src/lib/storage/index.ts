import { StorageAdapter } from "./types";
import { LocalAdapter } from "./local";
import { DriveAdapter } from "./drive";

let adapter: StorageAdapter | null = null;

export function resolveStorageDriver(): "drive" | "local" {
  const driver =
    process.env.STORAGE_DRIVER ||
    (process.env.GOOGLE_REFRESH_TOKEN ? "drive" : "local");
  // 오타(예: "Drive", "google")가 로컬 폴백으로 조용히 흘러가면 드라이브에 올린 줄
  // 알았던 파일이 서버 디스크에 쌓인다. 모르는 값은 명시적으로 실패시킨다.
  if (driver !== "drive" && driver !== "local") {
    throw new Error(
      `STORAGE_DRIVER 값이 올바르지 않습니다: "${driver}" (drive 또는 local)`,
    );
  }
  return driver;
}

export function getAdapter(): StorageAdapter {
  if (!adapter) {
    adapter =
      resolveStorageDriver() === "drive" ? new DriveAdapter() : new LocalAdapter();
  }
  return adapter;
}
