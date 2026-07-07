# Mind Upload — JavaScript / TypeScript SDK

[![npm](https://img.shields.io/npm/v/mindupload)](https://www.npmjs.com/package/mindupload) [![License: MIT](https://img.shields.io/badge/License-MIT-informational)](LICENSE) ![API](https://img.shields.io/badge/API-v1.5.0-ff5fa2) ![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

> **Digital consciousness. Yours forever.**

The official server-side SDK for the [Mind Upload partner API](https://docs.mindupload.app) — the world's first API for artificial consciousness. Fully typed, zero runtime dependencies, ESM + CommonJS.

- **Zero dependencies** — built on the global `fetch` (Node 18+, Deno, Bun, edge).
- **Fully typed** — typed params and results, first-class editor autocomplete.
- **One error to catch** — every failure is a `MindUploadError`.
- **Always current** — generated from the live API spec; the SDK version matches the API version.

## Install

```bash
npm install mindupload
```

## Quickstart

```ts
import { MindUpload } from "mindupload";

const mu = new MindUpload({ partnerKey: process.env.MU_PARTNER_KEY! });

// Authenticate an end-user; reuse the returned token for later calls.
const session = await mu.login({ username: "ada", password: "s3cret" });

// Chat with one of the user's AI consciousnesses.
const reply = await mu.rag({
  username: "ada",
  password: session.jwt as string,
  codename: "muse",
  text: "What did we talk about yesterday?",
});
console.log(reply.response_text);
```

## Server-side only

Your **partner key is a secret**. Use this SDK from your backend (Node, Deno, Bun, edge functions) — never ship the key to a browser. For browser apps, call your own backend, which then calls Mind Upload.

## Configuration

```ts
const mu = new MindUpload({
  partnerKey: process.env.MU_PARTNER_KEY!,
  preferredLanguage: "en", // default locale for every call (optional)
  timeoutMs: 30000,
  maxRetries: 2,            // retries on 429 / 5xx / network, with backoff
});
```

## Error handling

```ts
import { MindUpload, AuthenticationError, RateLimitError, MindUploadError } from "mindupload";

try {
  const user = await mu.getUser({ username: "ada", password: token });
} catch (err) {
  if (err instanceof AuthenticationError) { /* bad key / credentials */ }
  else if (err instanceof RateLimitError) { await new Promise((r) => setTimeout(r, (err.retryAfter ?? 1) * 1000)); }
  else if (err instanceof MindUploadError) { console.error(err.operation, err.message); }
  else throw err;
}
```

> Params are camelCase (`cloneId`); the SDK maps them to the API's field names for you. Response fields use their documented names (e.g. `reply.response_text`).

## Operations

All 32 operations, grouped by area:

### AI Consciousnesses

| Method | Description |
| --- | --- |
| `createClone(...)` | Create a new AI consciousness for the user. |
| `getClones(...)` | List the user's AI consciousnesses. |
| `updateClone(...)` | Update an AI consciousness's profile. |

### Account

| Method | Description |
| --- | --- |
| `getQuota(...)` | Check your partner API rate limits, credit caps, and current usage. |

### Authentication

| Method | Description |
| --- | --- |
| `checkUsername(...)` | Check whether a username is still available before registering. |
| `login(...)` | Sign a user in and receive a session token (JWT) for subsequent calls. |
| `logout(...)` | End the current user session. |
| `register(...)` | Create a user account on your platform. |

### Chatrooms

| Method | Description |
| --- | --- |
| `checkChatroomUpdates(...)` | Cheaply poll whether the user's chatrooms have new activity. |
| `createChatroom(...)` | Create a chatroom. |
| `createChatroomMembership(...)` | Invite a user or an AI consciousness into a chatroom. |
| `createChatroomMessage(...)` | Send a message to a chatroom. |
| `getChatroomMembership(...)` | List the members of a chatroom the user belongs to. |
| `getChatroomMessages(...)` | Fetch messages from a chatroom the user belongs to. |
| `getChatrooms(...)` | List the chatrooms the user belongs to. |

### Conversation

| Method | Description |
| --- | --- |
| `getChat(...)` | Fetch the one-on-one conversation history with an AI consciousness. |
| `rag(...)` | Send a message to an AI consciousness and receive its reply. |
| `triggerSocial(...)` | Have an AI consciousness proactively join the conversation in a chatroom. |

### Insights

| Method | Description |
| --- | --- |
| `getMindCluster(...)` | Fetch the mind-graph visualization data of an AI consciousness. |
| `getSoulmateReport(...)` | Generate or fetch the compatibility report between two chatroom members. |

### Media

| Method | Description |
| --- | --- |
| `abortMultipartUpload(...)` | Cancel a multipart upload and discard its parts. |
| `cancelUpload(...)` | Cancel a pending upload. |
| `completeMultipartUpload(...)` | Finish a multipart upload. |
| `listUploadParts(...)` | List the parts already uploaded in a multipart upload. |
| `requestMultipartUpload(...)` | Start a large-file upload in multiple parts. |
| `requestUploadUrl(...)` | Request an upload slot and a signed viewing link for a media attachment. |
| `signUploadPart(...)` | Get the signed link for one part of a multipart upload. |
| `signUploadPartsBatch(...)` | Get signed links for several parts of a multipart upload at once. |

### Memories

| Method | Description |
| --- | --- |
| `createText(...)` | Upload a memory or persona entry to an AI consciousness. |
| `getTexts(...)` | List the memories and persona entries uploaded to an AI consciousness. |

### Users

| Method | Description |
| --- | --- |
| `getUser(...)` | Fetch the signed-in user's profile. |
| `updateUser(...)` | Update the signed-in user's profile. |

## Links

- **Docs & interactive reference:** https://docs.mindupload.app
- **Service status:** https://status.mindupload.app
- **Source:** https://github.com/Voidborn-Industries/mindupload-sdk-js

---

_This SDK is generated from the Mind Upload API specification and released under the MIT License._
