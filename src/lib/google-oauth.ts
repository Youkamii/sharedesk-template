import type { NextRequest } from "next/server";
import { resolvePublicOrigin } from "@/lib/public-origin";

export const STATE_COOKIE = "sharedesk_oauth";
export const LOGIN_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export function loginRedirectUri(req: NextRequest): string {
  return `${resolvePublicOrigin(req.nextUrl.origin)}/api/auth/google/callback`;
}
