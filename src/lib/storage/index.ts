import { StorageAdapter } from "./types";
import { LocalAdapter } from "./local";

let adapter: StorageAdapter | null = null;

export function getAdapter(): StorageAdapter {
  if (!adapter) {
    const driver =
      process.env.STORAGE_DRIVER ||
      (process.env.GOOGLE_REFRESH_TOKEN ? "drive" : "local");
    if (driver === "drive") {
      throw new Error("drive 드라이버는 아직 구현 전입니다 (이슈 #5)");
    }
    adapter = new LocalAdapter();
  }
  return adapter;
}
