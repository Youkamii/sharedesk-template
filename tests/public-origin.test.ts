import assert from "node:assert/strict";
import test from "node:test";
import { resolvePublicOrigin } from "@/lib/public-origin";

test("PUBLIC_BASE_URL takes precedence and its trailing slash is normalized", () => {
  assert.equal(
    resolvePublicOrigin("https://preview.example.com", {
      PUBLIC_BASE_URL: "  https://desk.example.com/  ",
      VERCEL_PROJECT_PRODUCTION_URL: "production.example.com",
    }),
    "https://desk.example.com",
  );
});

test("Vercel's production hostname is used when PUBLIC_BASE_URL is empty", () => {
  assert.equal(
    resolvePublicOrigin("https://sharedesk-git-feature.vercel.app", {
      PUBLIC_BASE_URL: " ",
      VERCEL_PROJECT_PRODUCTION_URL: "sharedesk.example.com",
    }),
    "https://sharedesk.example.com",
  );
});

test("request origin is the final fallback and VERCEL_URL previews are ignored", () => {
  assert.equal(
    resolvePublicOrigin("http://localhost:3000", {
      VERCEL_URL: "sharedesk-git-feature.vercel.app",
    }),
    "http://localhost:3000",
  );
});

test("malformed or non-http(s) PUBLIC_BASE_URL values are rejected", () => {
  for (const value of [
    "desk.example.com",
    "ftp://desk.example.com",
    "https://desk.example.com/path",
    "https://desk.example.com?source=preview",
    "https://desk.example.com#preview",
    "https://user:pass@desk.example.com",
  ]) {
    assert.throws(
      () =>
        resolvePublicOrigin("https://request.example.com", {
          PUBLIC_BASE_URL: value,
          VERCEL_PROJECT_PRODUCTION_URL: "production.example.com",
        }),
      /PUBLIC_BASE_URL/,
    );
  }
});

test("malformed Vercel production hostnames are rejected", () => {
  for (const value of [
    "ftp://desk.example.com",
    "desk.example.com/path",
    "desk.example.com?source=preview",
    "user:pass@desk.example.com",
  ]) {
    assert.throws(
      () =>
        resolvePublicOrigin("https://request.example.com", {
          VERCEL_PROJECT_PRODUCTION_URL: value,
        }),
      /VERCEL_PROJECT_PRODUCTION_URL/,
    );
  }
});
