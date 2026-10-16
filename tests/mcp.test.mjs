/** Exercise the native server through the actual protocol and SDK HTTP boundary. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
const GRANT = {
  success: true, status: "exchanged", access_token: "fictional-test-access", refresh_token: "fictional-test-refresh",
  access_token_expires_at: 10000, clone_ids: ["approved-mind"], clone_nicknames: { "approved-mind": "My consciousness" },
};

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
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["consult_mind", "review_work"]);
    assert.equal(tools[0].annotations.readOnlyHint, true);
    assert.ok(tools.every(tool => tool.inputSchema.properties.media_evidence));
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
    assert.equal(reviewResult.structuredContent.media_analysis_status, "requested_unverified");
    assert.deepEqual(reviewResult.structuredContent.media_evidence, FIXTURE.media_evidence);
  }, { externalSubject: FIXTURE.external_subject, cloneId: FIXTURE.clone_id, grant: { ...GRANT, clone_ids: [FIXTURE.clone_id], clone_nicknames: { [FIXTURE.clone_id]: "Fixture mind" } } });
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
