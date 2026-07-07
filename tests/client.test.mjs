import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MindUpload,
  ApiError,
  AuthenticationError,
  RateLimitError,
  MindUploadError,
  MindUploadConnectionError,
} from "../dist/index.js";

function stub(handler) {
  globalThis.fetch = handler;
}
function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(payload);
    },
    headers: { get: (name) => headers[name] ?? null },
  };
}

test("request shape: POST /v1/op, auth header, camelCase->snake_case, locale injected", async () => {
  let captured;
  stub(async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return jsonResponse({ success: true, jwt: "tok" });
  });
  const mu = new MindUpload({ partnerKey: "pk_test", preferredLanguage: "en" });
  const result = await mu.requestUploadUrl({ username: "ada", fileSizeBytes: 10, hasThumbnail: false });
  assert.equal(captured.init.method, "POST");
  assert.ok(captured.url.endsWith("/v1/request_upload_url"));
  assert.equal(captured.init.headers["X-Partner-Key"], "pk_test");
  assert.match(captured.init.headers["User-Agent"], /mindupload-js\//);
  assert.deepEqual(captured.body, {
    username: "ada",
    file_size_bytes: 10,
    has_thumbnail: false,
    preferred_language: "en",
  });
  assert.equal(result.jwt, "tok");
});

test("per-call preferredLanguage overrides the client default", async () => {
  let body;
  stub(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ success: true });
  });
  const mu = new MindUpload({ partnerKey: "pk", preferredLanguage: "en" });
  await mu.checkUsername({ username: "ada", preferredLanguage: "zh-cn" });
  assert.equal(body.preferred_language, "zh-cn");
});

test("missing partnerKey throws", () => {
  assert.throws(() => new MindUpload({ partnerKey: "" }));
});

test("logical failure (success:false) rejects with MindUploadError, not ApiError", async () => {
  stub(async () => jsonResponse({ success: false, error_message: "no such user" }));
  const mu = new MindUpload({ partnerKey: "pk" });
  await assert.rejects(mu.getUser({ username: "nobody" }), (err) => {
    assert.ok(err instanceof MindUploadError);
    assert.ok(!(err instanceof ApiError));
    assert.equal(err.message, "no such user");
    assert.equal(err.operation, "get_user");
    return true;
  });
});

test("401 rejects with AuthenticationError", async () => {
  stub(async () => jsonResponse({ success: false, error_message: "bad key" }, { status: 401 }));
  const mu = new MindUpload({ partnerKey: "pk", maxRetries: 0 });
  await assert.rejects(mu.login({ username: "a" }), (err) => {
    assert.ok(err instanceof AuthenticationError);
    assert.equal(err.status, 401);
    return true;
  });
});

test("429 retries then rejects with RateLimitError carrying retryAfter", async () => {
  let calls = 0;
  stub(async () => {
    calls += 1;
    return jsonResponse({ success: false, error_message: "slow" }, { status: 429, headers: { "Retry-After": "0" } });
  });
  const mu = new MindUpload({ partnerKey: "pk", maxRetries: 1 });
  await assert.rejects(mu.rag({ username: "a" }), (err) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, 0);
    return true;
  });
  assert.equal(calls, 2);
});

test("network error rejects with MindUploadConnectionError (not retried)", async () => {
  let calls = 0;
  stub(async () => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  });
  const mu = new MindUpload({ partnerKey: "pk", maxRetries: 2 });
  await assert.rejects(mu.rag({ username: "a" }), (err) => {
    assert.ok(err instanceof MindUploadConnectionError);
    return true;
  });
  assert.equal(calls, 1);
});

test("5xx is ApiError and is not retried", async () => {
  let calls = 0;
  stub(async () => {
    calls += 1;
    return jsonResponse({ success: false, error_message: "boom" }, { status: 500 });
  });
  const mu = new MindUpload({ partnerKey: "pk", maxRetries: 2 });
  await assert.rejects(mu.rag({ username: "a" }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    return true;
  });
  assert.equal(calls, 1);
});

test("response body read failure rejects with MindUploadConnectionError", async () => {
  stub(async () => ({
    status: 200,
    ok: true,
    async text() {
      throw new Error("aborted mid-body");
    },
    headers: { get: () => null },
  }));
  const mu = new MindUpload({ partnerKey: "pk", maxRetries: 0 });
  await assert.rejects(mu.rag({ username: "a" }), (err) => {
    assert.ok(err instanceof MindUploadConnectionError);
    return true;
  });
});
