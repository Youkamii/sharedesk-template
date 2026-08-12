import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getAdapter } from "../src/lib/storage";
import { ROOT_ID } from "../src/lib/storage/types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

const GOOGLE_NATIVE_FILES = [
  {
    label: "문서",
    mimeType: "application/vnd.google-apps.document",
  },
  {
    label: "스프레드시트",
    mimeType: "application/vnd.google-apps.spreadsheet",
  },
  {
    label: "프레젠테이션",
    mimeType: "application/vnd.google-apps.presentation",
  },
  {
    label: "드로잉",
    mimeType: "application/vnd.google-apps.drawing",
  },
] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 환경 변수가 필요합니다`);
  return value;
}

async function accessToken(): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required("GOOGLE_CLIENT_ID"),
      client_secret: required("GOOGLE_CLIENT_SECRET"),
      refresh_token: required("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google 토큰 발급 실패 (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Google access token이 없습니다");
  return body.access_token;
}

async function createGoogleNativeFile(
  token: string,
  file: (typeof GOOGLE_NATIVE_FILES)[number],
): Promise<string> {
  const response = await fetch(
    `${DRIVE_API}/files?fields=id,mimeType&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        name: `[ShareDesk ${file.label} preview check] ${randomUUID()}`,
        mimeType: file.mimeType,
        parents: [required("DRIVE_ROOT_FOLDER_ID")],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Google ${file.label} 생성 실패 (${response.status})`);
  }
  const body = (await response.json()) as { id?: string; mimeType?: string };
  if (!body.id || body.mimeType !== file.mimeType) {
    throw new Error(`Google ${file.label} 생성 응답이 올바르지 않습니다`);
  }
  return body.id;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

async function cleanup(ids: string[]): Promise<void> {
  const adapter = getAdapter();
  const failures: unknown[] = [];
  for (const id of ids.reverse()) {
    try {
      await adapter.remove(id);
      const entry = (await adapter.listTrash()).find((item) => item.id === id);
      if (entry) await adapter.purge(id, entry.version);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(`검증용 파일 ${failures.length}개를 정리하지 못했습니다`);
  }
}

async function main() {
  if (!process.argv.includes("--live")) {
    throw new Error("실제 Drive 검증은 --live 옵션을 붙여 실행하세요");
  }
  if (process.env.STORAGE_DRIVER !== "drive") {
    throw new Error("STORAGE_DRIVER=drive 환경에서만 실행할 수 있습니다");
  }

  const adapter = getAdapter();
  const createdIds: string[] = [];
  let verificationError: unknown = null;

  try {
    const token = await accessToken();
    for (const nativeFile of GOOGLE_NATIVE_FILES) {
      const fileId = await createGoogleNativeFile(token, nativeFile);
      createdIds.push(fileId);

      const downloaded = await adapter.download(fileId);
      const pdf = await readAll(downloaded.stream);
      assert.equal(downloaded.status, 200, `${nativeFile.label} HTTP status`);
      assert.equal(downloaded.mimeType, "application/pdf", nativeFile.label);
      assert.equal(downloaded.acceptRanges, false, nativeFile.label);
      assert.equal(
        pdf.subarray(0, 5).toString("ascii"),
        "%PDF-",
        nativeFile.label,
      );
    }

    const videoBytes = new Uint8Array(4096);
    videoBytes.set(
      Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"),
    );
    const video = await adapter.upload(
      ROOT_ID,
      `[ShareDesk range check] ${randomUUID()}.mp4`,
      "video/mp4",
      new Blob([videoBytes]).stream(),
    );
    createdIds.push(video.id);

    const ranged = await adapter.download(video.id, "bytes=16-31");
    const part = await readAll(ranged.stream);
    assert.equal(ranged.status, 206);
    assert.equal(ranged.mimeType, "video/mp4");
    assert.equal(ranged.contentRange, "bytes 16-31/4096");
    assert.equal(part.length, 16);

    console.info(
      "PASS: Google 문서·스프레드시트·프레젠테이션·드로잉 PDF 미리보기와 Drive Range(206) 응답",
    );
  } catch (error) {
    verificationError = error;
  }

  try {
    await cleanup(createdIds);
    console.info(`PASS: 검증용 Drive 항목 ${createdIds.length}개 정리`);
  } catch (cleanupError) {
    if (!verificationError) verificationError = cleanupError;
    else console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
  }

  if (verificationError) throw verificationError;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Drive 검증에 실패했습니다");
  process.exitCode = 1;
});
