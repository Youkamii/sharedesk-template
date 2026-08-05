import { NextResponse } from "next/server";
import { StorageError, StorageErrorCode } from "@/lib/storage/types";

const STATUS: Record<StorageErrorCode, number> = {
  NOT_FOUND: 404,
  BAD_ID: 400,
  BAD_NAME: 400,
  CONFLICT: 409,
  UPSTREAM: 502,
};

export function errorResponse(e: unknown) {
  if (e instanceof StorageError) {
    return NextResponse.json(
      { error: e.message, code: e.code },
      { status: STATUS[e.code] },
    );
  }
  console.error("[api]", e);
  return NextResponse.json({ error: "서버 오류가 발생했습니다" }, { status: 500 });
}
