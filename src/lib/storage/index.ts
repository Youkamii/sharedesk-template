import { StorageAdapter } from "./types";
import { LocalAdapter } from "./local";
import { DriveAdapter } from "./drive";

let adapter: StorageAdapter | null = null;

export function getAdapter(): StorageAdapter {
  if (!adapter) {
    const driver =
      process.env.STORAGE_DRIVER ||
      (process.env.GOOGLE_REFRESH_TOKEN ? "drive" : "local");
    adapter = driver === "drive" ? new DriveAdapter() : new LocalAdapter();
  }
  return adapter;
}
