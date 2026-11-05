/** Exercise the native server through the actual protocol and SDK HTTP boundary. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { MindUpload } from "../dist/index.js";
import { createMindUploadServer } from "../dist/mcp.js";

const FIXTURE = JSON.parse(await readFile(new URL("./mcp_parity_fixture.json", import.meta.url), "utf8"));
const CONSULT_ARGUMENTS = { question: "What matters for this task?", task_id: "task-one", decision_id: "decision-one" };
const REVIEW_ARGUMENTS = { user_request: "Keep drafts", work: "Cleared before acknowledgement", evidence: "No persistence test", task_id: "task-one", review_id: "review-one" };
const MAX_QUESTION_CHARACTERS = 8000;
const MAX_IDENTIFIER_CHARACTERS = 256;
const REQUESTED_SCOPES = ["clone:invoke", "clone:evidence", "clone:upload", "clone:review", "clone:learn"];
const TOOL_NAMES = ["consult_mind", "list_pending_memories", "remember", "review_pending_memory", "review_work"];
const SCREENSHOT_BYTES = Buffer.from([0x89, ...Buffer.from("PNG fictional screenshot bytes", "latin1")]);
const RECORDING_BYTES = Buffer.from("RIFF fictional recording bytes", "latin1");
const MEDIA_IDENTIFIERS = { "screenshot.png": "a".repeat(24), "voice.wav": "b".repeat(24) };
const IMAGE_LIMIT_BYTES = 50 * 1024 * 1024;
const UPLOAD_EXPIRY_SECONDS = 5000;
const EVIDENCE_DIRECTORIES = [];
// Every evidence directory a test wrote is removed once, after all tests.
after(() => Promise.all(EVIDENCE_DIRECTORIES.map(directory => rm(directory, { recursive: true, force: true }))));
const GRANT = {
  success: true, status: "exchanged", access_token: "fictional-test-access", refresh_token: "fictional-test-refresh",
  access_token_expires_at: 10000, clone_ids: ["approved-mind"], clone_nicknames: { "approved-mind": "My consciousness" },
};

/** Writes one screenshot and one recording into a fresh directory removed after all tests. */
async function evidenceFiles() {
  const directory = await mkdtemp(join(tmpdir(), "mindupload-evidence-test-"));
  EVIDENCE_DIRECTORIES.push(directory);
  const screenshot = join(directory, "screenshot.png");
  const recording = join(directory, "voice.wav");
  await writeFile(screenshot, SCREENSHOT_BYTES);
  await writeFile(recording, RECORDING_BYTES);
  return [screenshot, recording];
}

/** Answers the four media operations; each item stays processing until its final read. */
function mediaResponder({ checksUntilFinal = 1, finalStatus = "completed", putStatus = () => 200 }) {
  const reads = new Map();
  const media = (uploadId, analysisStatus) => {
    const filename = uploadId.replace(/^upload-/, "");
    return { success: true, media: { media_id: MEDIA_IDENTIFIERS[filename], analysis_status: analysisStatus, media_type: filename.endsWith(".png") ? "image" : "audio" } };
  };
  const json = value => new Response(JSON.stringify(value), { status: 200 });
  return (operation, body) => {
    if (operation === "PUT") return new Response(null, { status: putStatus() });
    if (operation === "request_external_media_upload") return json({
      success: true, upload_id: "upload-" + body.filename, presigned_url: "https://uploads.example.com/" + body.filename,
      required_headers: { "Content-Type": body.content_type, "If-None-Match": "*" }, expires_at: UPLOAD_EXPIRY_SECONDS,
    });
    if (operation === "start_external_media_analysis") return json(media(body.upload_id, "pending"));
    if (operation === "get_external_media_analysis") {
      reads.set(body.upload_id, (reads.get(body.upload_id) ?? 0) + 1);
      return json(media(body.upload_id, reads.get(body.upload_id) >= checksUntilFinal ? finalStatus : "processing"));
    }
  };
}

/** One server/client pair and one mocked fetch serialize mutable authorization state per test. */
async function withHarness(callback, options = {}) {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const diagnostics = [];
  console.error = (...values) => diagnostics.push(values.join(" "));
  const calls = [];
  let monotonic = 0;
  let wall = 0;
  globalThis.fetch = async (url, request) => {
    if (request.method === "PUT") {
      // Evidence bytes go to the signed address, not the partner API; record exactly what was sent.
      const body = { url, headers: request.headers, bytes: Buffer.from(await request.body.arrayBuffer()).toString("base64"), redirect: request.redirect };
      calls.push({ operation: "PUT", body });
      return (await options.response?.("PUT", body, calls)) ?? new Response(null, { status: 200 });
    }
    const operation = new URL(url).pathname.split("/").at(-1);
    const body = JSON.parse(request.body);
    calls.push({ operation, body });
    const overridden = await options.response?.(operation, body, calls);
    if (overridden) return overridden;
    const response = operation === "create_external_authorization_request" ? {
      success: true, device_code: "fictional-device-code", verification_uri_complete: "https://example.com/consent", poll_interval: 5, expires_in: 600,
    } : operation === "exchange_external_authorization" || operation === "refresh_external_authorization" ? options.grant ?? GRANT : {
      success: true, status: "succeeded", response_text: "Personal response", invocation_id: "invocation-one", idempotent_replay: false,
    };
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const server = createMindUploadServer({
    client: options.configured === false ? undefined : new MindUpload({ partnerKey: "fictional-partner-key", maxRetries: 0 }),
    installationId: "installation-one", externalSubject: options.externalSubject ?? "owner-one", cloneId: options.cloneId,
    monotonicTime: () => monotonic, wallTime: () => wall,
    sleep: async milliseconds => { monotonic += milliseconds; wall += milliseconds; },
  });
  const client = new Client({ name: "native-mcp-tests", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const harness = {
    client, calls, diagnostics, advance(milliseconds) { monotonic += milliseconds; wall += milliseconds; },
    async call(name, arguments_) { return client.callTool({ name, arguments: arguments_ }); },
    async authorize() {
      assert.equal((await harness.call("consult_mind", CONSULT_ARGUMENTS)).structuredContent.status, "authorization_required");
      harness.advance(5000);
      return harness.call("consult_mind", CONSULT_ARGUMENTS);
    },
  };
  try { await callback(harness); }
  finally { await client.close(); await server.close(); globalThis.fetch = originalFetch; console.error = originalConsoleError; }
}

test("native stdio executable discovers both tools and reports missing setup without network", async () => {
  const environment = { ...process.env };
  // A fresh subprocess proves discovery without inheriting any personal configuration.
  for (const name of ["MINDUPLOAD_PARTNER_KEY", "MINDUPLOAD_INSTALLATION_ID", "MINDUPLOAD_EXTERNAL_SUBJECT", "MINDUPLOAD_CLONE_ID"]) delete environment[name];
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/mcp.js", import.meta.url))], env: environment, stderr: "pipe" });
  const client = new Client({ name: "stdio-install-test", version: "1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), TOOL_NAMES);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint));
    // Both invocation tools accept link media, private evidence files and learning.
    const invocationTools = tools.filter(tool => tool.name === "consult_mind" || tool.name === "review_work");
    for (const tool of invocationTools) {
      assert.ok(tool.inputSchema.properties.media_evidence && tool.inputSchema.properties.evidence_files && tool.inputSchema.properties.learn, tool.name);
    }
    // Agents choose these tools and their arguments from this text before any setup exists, so none may be blank.
    assert.ok(invocationTools.every(tool => tool.description.includes("Mind Upload consciousness")));
    assert.ok(invocationTools.every(tool => Object.values(tool.inputSchema.properties).every(property => property.description)));
    const result = await client.callTool({ name: "review_work", arguments: REVIEW_ARGUMENTS });
    assert.equal(result.structuredContent.status, "setup_required");
    assert.match(result.structuredContent.message, /no review has run/);
    assert.equal(result.structuredContent.setup_url, "https://docs.mindupload.app/mcp");
  } finally { await client.close(); }
});

test("owner consent is cadence-limited and then reuses one authorized invocation", async () => {
  await withHarness(async harness => {
    assert.equal((await harness.call("consult_mind", CONSULT_ARGUMENTS)).structuredContent.status, "authorization_required");
    assert.equal((await harness.call("consult_mind", CONSULT_ARGUMENTS)).structuredContent.status, "authorization_required");
    assert.equal(harness.calls.length, 1, "early retries do not poll owner authorization");
    harness.advance(5000);
    await harness.call("consult_mind", CONSULT_ARGUMENTS);
    assert.deepEqual(harness.calls.map(call => call.operation), ["create_external_authorization_request", "exchange_external_authorization", "invoke_external_clone"]);
    const first = harness.calls.at(-1).body;
    const result = await harness.call("consult_mind", CONSULT_ARGUMENTS);
    assert.equal(result.structuredContent.consciousness.nickname, "My consciousness");
    assert.equal(harness.calls.at(-1).body.idempotency_key, first.idempotency_key);
    assert.equal(harness.calls.at(-1).body.conversation_id, first.conversation_id);
    assert.ok(!JSON.stringify(result).includes(GRANT.access_token));
  });
});

test("Unicode limits count characters rather than UTF-16 code units", async () => {
  await withHarness(async harness => {
    const { tools } = await harness.client.listTools();
    const consultation = tools.find(tool => tool.name === "consult_mind");
    assert.equal(consultation.inputSchema.properties.question.maxLength, MAX_QUESTION_CHARACTERS);
    assert.equal(consultation.inputSchema.properties.task_id.maxLength, MAX_IDENTIFIER_CHARACTERS);
    const result = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, question: "😀".repeat(MAX_QUESTION_CHARACTERS), task_id: "😀".repeat(MAX_IDENTIFIER_CHARACTERS) });
    assert.equal(result.structuredContent.status, "setup_required");
    assert.equal(harness.calls.length, 0);
  }, { configured: false });
});

test("both tools match Python Unicode receipts, media payload and shared task history", async () => {
  await withHarness(async harness => {
    await harness.authorize();
    await harness.call("consult_mind", { question: FIXTURE.consultation_question, task_id: FIXTURE.task_id, decision_id: FIXTURE.event_id, media_evidence: FIXTURE.media_evidence });
    const consultation = harness.calls.at(-1).body;
    const reviewResult = await harness.call("review_work", { user_request: FIXTURE.review_user_request, work: FIXTURE.review_work, evidence: FIXTURE.review_evidence, task_id: FIXTURE.task_id, review_id: FIXTURE.event_id, media_evidence: FIXTURE.media_evidence });
    const review = harness.calls.at(-1).body;
    assert.equal(consultation.idempotency_key, FIXTURE.consultation_idempotency_key);
    assert.equal(review.idempotency_key, FIXTURE.review_idempotency_key);
    assert.equal(consultation.conversation_id, FIXTURE.conversation_id);
    assert.equal(review.conversation_id, FIXTURE.conversation_id);
    assert.equal(consultation.text, FIXTURE.consultation_text);
    assert.equal(review.text, FIXTURE.review_text);
    assert.equal(consultation.request_kind, FIXTURE.consultation_request_kind);
    assert.equal(review.request_kind, FIXTURE.review_request_kind);
    // The default response carries no per-item outcome, so nothing is claimed about perception.
    assert.equal(reviewResult.structuredContent.media_analysis_status, "requested_unverified");
    assert.equal(reviewResult.structuredContent.media_analysis, undefined);
    assert.deepEqual(reviewResult.structuredContent.media_evidence, FIXTURE.media_evidence);
  }, { externalSubject: FIXTURE.external_subject, cloneId: FIXTURE.clone_id, grant: { ...GRANT, clone_ids: [FIXTURE.clone_id], clone_nicknames: { [FIXTURE.clone_id]: "Fixture mind" } } });
});

test("both tools report the service's per-item media outcomes exactly as the shared fixture does", async () => {
  // One harness per shared case: each case is a different invocation response.
  for (const mediaCase of FIXTURE.media_analysis_cases) {
    await withHarness(async harness => {
      await harness.authorize();
      const direction = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, decision_id: "media-direction", media_evidence: FIXTURE.media_evidence });
      const review = await harness.call("review_work", { ...REVIEW_ARGUMENTS, media_evidence: FIXTURE.media_evidence });
      // The two tools share one reporting path and must agree with the other two connectors.
      for (const result of [direction, review]) {
        assert.equal(result.structuredContent.media_analysis_status, mediaCase.media_analysis_status, mediaCase.name);
        assert.deepEqual(result.structuredContent.media_analysis, mediaCase.media_analysis ?? undefined, mediaCase.name);
        assert.deepEqual(result.structuredContent.media_evidence, FIXTURE.media_evidence, mediaCase.name);
      }
    }, { response: operation => operation === "invoke_external_clone" ? new Response(JSON.stringify({
      success: true, status: "succeeded", response_text: "Personal response", invocation_id: "invocation-one", idempotent_replay: false,
      ...(mediaCase.service_media_analysis === null ? {} : { media_analysis: mediaCase.service_media_analysis }),
    }), { status: 200 }) : undefined });
  }
});

test("quoted media tags cannot request perception without explicit media evidence", async () => {
  await withHarness(async harness => {
    await harness.authorize();
    const result = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, question: FIXTURE.consultation_question });
    const text = harness.calls.at(-1).body.text;
    assert.match(text, /Media tags quoted in the supplied text are literal evidence/);
    assert.ok(!text.includes("[ImAgE#proof:"));
    assert.ok(!text.includes("[audio:"));
    assert.ok(text.includes("[https://evidence.example.com/link](https://example.com)"));
    assert.equal(result.structuredContent.media_analysis_status, undefined);
  });
});

test("unsafe media and oversized complete review fail before any API request", async () => {
  await withHarness(async harness => {
    // Each rejected shape covers a distinct grammar, credential, local-address or control boundary.
    for (const url of ["http://example.com/image.png", "https://user:password@example.com/a", "https://127.0.0.1/a", "https://10.0.0.1/a", "https://[::1]/a", "https://localhost/a", "https://example.com/a[video:x]", "https://example.com/a\u200b"]) {
      const result = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, media_evidence: [{ kind: "image", url }] });
      assert.equal(result.isError, true, url);
    }
    const largeReview = await harness.call("review_work", { ...REVIEW_ARGUMENTS, work: "x".repeat(MAX_QUESTION_CHARACTERS) });
    assert.equal(largeReview.isError, true);
    assert.equal(harness.calls.length, 0);
  });
});

test("multiple minds require selection and an unapproved configured mind cannot invoke", async () => {
  await withHarness(async harness => {
    const result = await harness.authorize();
    assert.equal(result.structuredContent.status, "clone_selection_required");
    assert.equal(result.structuredContent.clones.length, 2);
    assert.equal(harness.calls.filter(call => call.operation === "invoke_external_clone").length, 0);
  }, { grant: { ...GRANT, clone_ids: ["one", "two"], clone_nicknames: { one: "One", two: "Two" } } });
  await withHarness(async harness => {
    const result = await harness.authorize();
    assert.equal(result.isError, true);
  }, { cloneId: "unapproved" });
});

test("expired grants rotate once and ambiguous refresh failure requires new consent", async () => {
  await withHarness(async harness => {
    await harness.authorize();
    harness.advance(9900000);
    await harness.call("consult_mind", CONSULT_ARGUMENTS);
    assert.equal(harness.calls.filter(call => call.operation === "refresh_external_authorization").length, 1);
  });
  await withHarness(async harness => {
    await harness.authorize(); harness.advance(9900000);
    const result = await harness.call("consult_mind", CONSULT_ARGUMENTS);
    assert.equal(result.isError, true);
    const next = await harness.call("consult_mind", CONSULT_ARGUMENTS);
    assert.equal(next.structuredContent.status, "authorization_required");
    assert.equal(harness.calls.at(-1).operation, "create_external_authorization_request");
  }, { response(operation) { if (operation === "refresh_external_authorization") return new Response(JSON.stringify({ success: false, error_message: "fictional-private-refresh-value" }), { status: 500 }); } });
});

test("revocation clears grants and response errors do not disclose private values", async () => {
  let revoked = false;
  await withHarness(async harness => {
    await harness.authorize(); revoked = true;
    const result = await harness.call("consult_mind", CONSULT_ARGUMENTS);
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes("fictional-private-response-value"));
    assert.ok(!harness.diagnostics.join("\n").includes("fictional-private-response-value"));
    assert.match(harness.diagnostics.join("\n"), /Mind Upload MCP request failed/);
    assert.equal((await harness.call("consult_mind", CONSULT_ARGUMENTS)).structuredContent.status, "authorization_required");
  }, { response(operation) { if (revoked && operation === "invoke_external_clone") return new Response(JSON.stringify({ success: false, error_message: "upstream rejected input\n    at fictional-private-response-value" }), { status: 403 }); } });
});

test("overlapping protocol calls serialize actual SDK invocations", async () => {
  let active = 0;
  let maximumActive = 0;
  await withHarness(async harness => {
    await harness.authorize();
    // Two callers deliberately overlap; the server must preserve concurrency one around owner grants.
    await Promise.all([harness.call("consult_mind", CONSULT_ARGUMENTS), harness.call("review_work", REVIEW_ARGUMENTS)]);
    assert.equal(maximumActive, 1);
  }, { async response(operation) {
    if (operation !== "invoke_external_clone") return;
    active += 1; maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1;
  } });
});

test("consent requests every permission, all ticked on the approval screen", async () => {
  await withHarness(async harness => {
    await harness.call("consult_mind", CONSULT_ARGUMENTS);
    assert.deepEqual(harness.calls[0].body.requested_scopes, REQUESTED_SCOPES);
    assert.equal(harness.calls[0].body.optional_scopes, undefined);
  });
});

test("evidence files are uploaded privately, analyzed, then read by the mind as literal-text media", async () => {
  const [screenshot, recording] = await evidenceFiles();
  await withHarness(async harness => {
    await harness.authorize();
    const result = await harness.call("review_work", { ...REVIEW_ARGUMENTS, evidence_files: [screenshot, recording] });
    const uploads = harness.calls.filter(call => call.operation === "request_external_media_upload").map(call => call.body);
    assert.deepEqual(uploads.map(({ idempotency_key, ...fields }) => fields), [
      { access_token: GRANT.access_token, installation_id: "installation-one", external_subject: "owner-one", clone_id: "approved-mind",
        filename: "screenshot.png", content_type: "image/png", file_size_bytes: SCREENSHOT_BYTES.length, media_type: "image" },
      { access_token: GRANT.access_token, installation_id: "installation-one", external_subject: "owner-one", clone_id: "approved-mind",
        filename: "voice.wav", content_type: "audio/wav", file_size_bytes: RECORDING_BYTES.length, media_type: "audio" },
    ]);
    const puts = harness.calls.filter(call => call.operation === "PUT");
    assert.deepEqual(puts.map(put => put.body), [
      { url: "https://uploads.example.com/screenshot.png", headers: { "Content-Type": "image/png", "If-None-Match": "*" }, bytes: SCREENSHOT_BYTES.toString("base64"), redirect: "error" },
      { url: "https://uploads.example.com/voice.wav", headers: { "Content-Type": "audio/wav", "If-None-Match": "*" }, bytes: RECORDING_BYTES.toString("base64"), redirect: "error" },
    ]);
    assert.deepEqual(harness.calls.filter(call => call.operation === "start_external_media_analysis").map(call => call.body.upload_id), ["upload-screenshot.png", "upload-voice.wav"]);
    // Two sequential rounds for both items: the first still processing, the second completed.
    assert.equal(harness.calls.filter(call => call.operation === "get_external_media_analysis").length, 4);
    const invocation = harness.calls.at(-1);
    assert.equal(invocation.operation, "invoke_external_clone");
    assert.equal(invocation.body.literal_text, true);
    assert.deepEqual(invocation.body.media_ids, ["a".repeat(24), "b".repeat(24)]);
    assert.equal(invocation.body.learn, undefined);
    assert.equal(result.structuredContent.media_analysis_status, "analyzed");
    assert.deepEqual(result.structuredContent.evidence, [
      { file: screenshot, evidence_id: "upload-screenshot.png", media_type: "image", analysis_status: "completed" },
      { file: recording, evidence_id: "upload-voice.wav", media_type: "audio", analysis_status: "completed" },
    ]);
    assert.ok(!JSON.stringify(result).includes(GRANT.access_token));
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:evidence"] }, response: mediaResponder({ checksUntilFinal: 2 }) });
});

test("an identical evidence retry reuses each upload and accepts bytes already stored", async () => {
  const [screenshot] = await evidenceFiles();
  let stored = false;
  await withHarness(async harness => {
    await harness.authorize();
    const first = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, evidence_files: [screenshot] });
    stored = true;
    const retry = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, evidence_files: [screenshot] });
    await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, decision_id: "decision-two", evidence_files: [screenshot] });
    const keys = harness.calls.filter(call => call.operation === "request_external_media_upload").map(call => call.body.idempotency_key);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.equal(retry.structuredContent.status, "succeeded");
    assert.deepEqual(retry.structuredContent.evidence, first.structuredContent.evidence);
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:upload"] }, response: mediaResponder({ putStatus: () => (stored ? 412 : 200) }) });
});

test("unsupported, unreadable, oversized or repeated evidence is refused before any request", async () => {
  const [screenshot] = await evidenceFiles();
  const directory = dirname(screenshot);
  await writeFile(join(directory, "notes.txt"), "not media");
  await writeFile(join(directory, "empty.png"), "");
  await mkdir(join(directory, "folder.png"));
  // A sparse file one byte over the image limit costs no disk space.
  await writeFile(join(directory, "huge.png"), "");
  await truncate(join(directory, "huge.png"), IMAGE_LIMIT_BYTES + 1);
  const refusals = [
    [join(directory, "notes.txt"), /not a supported evidence file/],
    ["relative/screenshot.png", /needs absolute paths/],
    [join(directory, "missing.png"), /cannot be read/],
    [join(directory, "empty.png"), /is empty/],
    [join(directory, "folder.png"), /is not a file/],
    [join(directory, "huge.png"), /can be at most 50 MB/],
  ];
  await withHarness(async harness => {
    // Each local refusal is its own trust-boundary case on one connection.
    for (const [path, explanation] of refusals) {
      const result = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, evidence_files: [path] });
      assert.equal(result.isError, true, path);
      assert.match(result.content[0].text, explanation);
      assert.match(result.content[0].text, /Nothing was sent/);
    }
    const repeated = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, evidence_files: [screenshot, screenshot] });
    assert.match(repeated.content[0].text, /listed twice/);
    assert.equal(harness.calls.length, 0);
  });
});

test("evidence cannot be mixed with media links or learning", async () => {
  const [screenshot] = await evidenceFiles();
  await withHarness(async harness => {
    const mixed = await harness.call("review_work", { ...REVIEW_ARGUMENTS, evidence_files: [screenshot], media_evidence: FIXTURE.media_evidence });
    assert.equal(mixed.isError, true);
    assert.match(mixed.content[0].text, /either evidence_files or media_evidence/);
    const learning = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, evidence_files: [screenshot], learn: true });
    assert.equal(learning.isError, true);
    assert.match(learning.content[0].text, /never kept as a memory/);
    assert.equal(harness.calls.length, 0);
  });
});

test("unfinished or failed analysis names each item and invokes nothing", async () => {
  const [screenshot, recording] = await evidenceFiles();
  await withHarness(async harness => {
    await harness.authorize();
    const waiting = await harness.call("review_work", { ...REVIEW_ARGUMENTS, evidence_files: [screenshot, recording] });
    assert.equal(waiting.isError, true);
    assert.match(waiting.content[0].text, /Still analyzing .*screenshot\.png \(processing\), .*voice\.wav \(processing\)/);
    assert.match(waiting.content[0].text, /retry the identical call/);
    // Twenty 3-second rounds fit the 60-second budget, each reading both unfinished items.
    assert.equal(harness.calls.filter(call => call.operation === "get_external_media_analysis").length, 40);
    assert.equal(harness.calls.filter(call => call.operation === "invoke_external_clone").length, 1);
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:evidence"] }, response: mediaResponder({ checksUntilFinal: 1000 }) });
  await withHarness(async harness => {
    await harness.authorize();
    const failed = await harness.call("review_work", { ...REVIEW_ARGUMENTS, evidence_files: [screenshot] });
    assert.match(failed.content[0].text, /could not analyze .*screenshot\.png/);
    assert.equal(harness.calls.filter(call => call.operation === "invoke_external_clone").length, 1);
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:evidence"] }, response: mediaResponder({ finalStatus: "failed" }) });
});

test("a region refusal explains media analysis and keeps the approval", async () => {
  const [screenshot] = await evidenceFiles();
  const media = mediaResponder({});
  await withHarness(async harness => {
    await harness.authorize();
    const refused = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, evidence_files: [screenshot] });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /cannot analyze media for this account/);
    assert.ok(!refused.content[0].text.includes("fictional-route-denial"));
    const plain = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, decision_id: "text-only" });
    assert.equal(plain.structuredContent.status, "succeeded");
    assert.equal(harness.calls.filter(call => call.operation === "create_external_authorization_request").length, 1);
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:evidence"] }, response(operation, body, calls) {
    if (operation === "start_external_media_analysis") return new Response(JSON.stringify({ success: false, error_message: "fictional-route-denial" }), { status: 403 });
    return media(operation, body, calls);
  } });
});

test("a missing permission is named, requested once, and leaves consultation working", async () => {
  const [screenshot] = await evidenceFiles();
  let upgraded = false;
  await withHarness(async harness => {
    await harness.authorize();
    const missing = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, decision_id: "with-evidence", evidence_files: [screenshot] });
    assert.equal(missing.structuredContent.status, "permission_required");
    assert.equal(missing.structuredContent.permission, "clone:evidence");
    assert.equal(missing.structuredContent.verification_url, "https://example.com/consent");
    assert.match(missing.structuredContent.message, /share task evidence/);
    assert.match(missing.structuredContent.message, /approve again with that permission ticked/);
    const plain = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, decision_id: "still-consults" });
    assert.equal(plain.structuredContent.status, "succeeded");
    upgraded = true;
    harness.advance(5000);
    const retried = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, decision_id: "with-evidence", evidence_files: [screenshot] });
    assert.equal(retried.structuredContent.status, "succeeded");
    assert.equal(harness.calls.at(-1).body.access_token, "fictional-upgraded-access");
    assert.equal(harness.calls.filter(call => call.operation === "create_external_authorization_request").length, 2);
  }, { grant: { ...GRANT, scopes: ["clone:invoke"] }, response(operation, body, calls) {
    if (upgraded && operation === "exchange_external_authorization") {
      return new Response(JSON.stringify({ ...GRANT, access_token: "fictional-upgraded-access", scopes: ["clone:invoke", "clone:evidence"] }), { status: 200 });
    }
    return mediaResponder({})(operation, body, calls);
  } });
});

test("a declined permission request keeps the existing approval", async () => {
  let declined = false;
  await withHarness(async harness => {
    await harness.authorize();
    const missing = await harness.call("remember", { text: "I prefer quiet mornings." });
    assert.equal(missing.structuredContent.permission, "clone:upload");
    assert.match(missing.structuredContent.message, /save memories/);
    declined = true;
    harness.advance(5000);
    const plain = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, decision_id: "after-decline" });
    assert.equal(plain.structuredContent.status, "succeeded");
    assert.equal(harness.calls.filter(call => call.operation === "exchange_external_authorization").length, 2);
    assert.equal(harness.calls.filter(call => call.operation === "upload_external_mind_data").length, 0);
  }, { grant: { ...GRANT, scopes: ["clone:invoke"] }, response(operation) {
    if (declined && operation === "exchange_external_authorization") return new Response(JSON.stringify({ success: true, status: "denied" }), { status: 200 });
  } });
});

test("learning needs its permission and gets a receipt separate from plain consultation", async () => {
  await withHarness(async harness => {
    await harness.authorize();
    const missing = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, learn: true });
    assert.equal(missing.structuredContent.permission, "clone:learn");
    assert.match(missing.structuredContent.message, /learn from these conversations/);
  });
  await withHarness(async harness => {
    await harness.authorize();
    const learned = await harness.call("consult_mind", { ...CONSULT_ARGUMENTS, learn: true });
    const [plain, learning] = harness.calls.filter(call => call.operation === "invoke_external_clone").map(call => call.body);
    assert.equal(learning.learn, true);
    assert.equal(plain.learn, undefined);
    assert.notEqual(plain.idempotency_key, learning.idempotency_key);
    assert.match(learned.structuredContent.learning, /owner's review/);
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:learn"] } });
});

test("remember saves once with a stable key and reports processing", async () => {
  let attempts = 0;
  const memory = { text: "I review contracts before signing.", source_label: "contract task" };
  await withHarness(async harness => {
    await harness.authorize();
    const processing = await harness.call("remember", memory);
    const saved = await harness.call("remember", memory);
    assert.deepEqual(processing.structuredContent, { status: "processing", retry_after_seconds: 2 });
    assert.deepEqual(saved.structuredContent, { status: "succeeded", text_id: "c".repeat(24), pending_owner_review: true });
    const [first, second] = harness.calls.filter(call => call.operation === "upload_external_mind_data").map(call => call.body);
    assert.deepEqual(first, second);
    assert.deepEqual({ ...first, idempotency_key: undefined }, {
      access_token: GRANT.access_token, installation_id: "installation-one", external_subject: "owner-one", clone_id: "approved-mind",
      text: memory.text, text_type: "memory", source_label: memory.source_label, idempotency_key: undefined,
    });
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:upload"] }, response(operation) {
    if (operation !== "upload_external_mind_data") return;
    attempts += 1;
    return new Response(JSON.stringify(attempts === 1
      ? { success: false, status: "processing", retry_after_seconds: 2, text_id: null }
      : { success: true, status: "succeeded", text_id: "c".repeat(24), pending_owner_review: true }), { status: 200 });
  } });
});

test("pending memories are listed in one page and reviewed exactly as the owner decides", async () => {
  const update = { text_id: "d".repeat(24), decision: "update", expected_content_revision: "revision-one", text: "Prefers green tea." };
  await withHarness(async harness => {
    await harness.authorize();
    const listed = await harness.call("list_pending_memories", {});
    assert.deepEqual(listed.structuredContent, { status: "listed", total_count: 1, has_next: false, memories: [
      { text_id: "d".repeat(24), text: "Prefers tea.", source_label: null, created_at: 1700000000, content_revision: "revision-one" },
    ] });
    assert.equal(harness.calls.at(-1).body.page_size, 20);
    const reviewed = await harness.call("review_pending_memory", update);
    assert.deepEqual(reviewed.structuredContent, { status: "updated", text_id: "d".repeat(24), pending_owner_review: true, content_revision: "revision-two" });
    const request = harness.calls.at(-1).body;
    assert.deepEqual({ text_id: request.text_id, decision: request.decision, expected_content_revision: request.expected_content_revision, text: request.text }, update);
    assert.match(request.idempotency_key, /^[0-9a-f]{64}$/);
    const approveWithText = await harness.call("review_pending_memory", { ...update, decision: "approve" });
    assert.equal(approveWithText.isError, true);
    assert.equal(harness.calls.filter(call => call.operation === "review_external_quarantined_text").length, 1);
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:review"] }, response(operation) {
    if (operation === "get_external_quarantined_texts") return new Response(JSON.stringify({ success: true, total_count: 1, has_next: false, texts: [
      { text_id: "d".repeat(24), text: "Prefers tea.", source_label: null, created_at: 1700000000, content_revision: "revision-one", text_type: "memory", updated_at: 1, pending_owner_review: true },
    ] }), { status: 200 });
    if (operation === "review_external_quarantined_text") return new Response(JSON.stringify({
      success: true, status: "updated", text_id: "d".repeat(24), content_revision: "revision-two", pending_owner_review: true, text: "Prefers green tea.",
    }), { status: 200 });
  } });
});

test("memory review tools without the review permission name it and send nothing", async () => {
  await withHarness(async harness => {
    await harness.authorize();
    const listed = await harness.call("list_pending_memories", {});
    const reviewed = await harness.call("review_pending_memory", { text_id: "d".repeat(24), decision: "reject", expected_content_revision: "revision-one" });
    // Both review tools share one gate; each must name the same missing permission.
    for (const result of [listed, reviewed]) {
      assert.equal(result.structuredContent.status, "permission_required");
      assert.equal(result.structuredContent.permission, "clone:review");
      assert.match(result.structuredContent.message, /review pending memories/);
    }
    assert.ok(!harness.calls.some(call => call.operation === "get_external_quarantined_texts" || call.operation === "review_external_quarantined_text"));
  }, { grant: { ...GRANT, scopes: ["clone:invoke", "clone:upload"] } });
});
