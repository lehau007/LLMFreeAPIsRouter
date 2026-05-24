# Connection Guide

This guide assumes the router is already running at `http://localhost:3000`.  
Replace `your-secret-token` with a token from your `CLIENT_TOKENS` env var.

---

## Authentication

Every request needs one of:

```
Authorization: Bearer your-secret-token
x-api-key: your-secret-token
```

---

## Connecting with Anthropic SDK (Python)

```python
import anthropic

client = anthropic.Anthropic(
    api_key="your-secret-token",
    base_url="http://localhost:3000",
)

message = client.messages.create(
    model="gemini-2.5-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

### Streaming

```python
with client.messages.stream(
    model="gemini-2.5-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a haiku."}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

---

## Connecting with Anthropic SDK (Node.js / TypeScript)

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "your-secret-token",
  baseURL: "http://localhost:3000",
});

const message = await client.messages.create({
  model: "gemini-2.5-flash",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(message.content[0].text);
```

### Streaming

```typescript
const stream = await client.messages.stream({
  model: "gemini-2.5-flash",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Write a haiku." }],
});

for await (const chunk of stream) {
  if (
    chunk.type === "content_block_delta" &&
    chunk.delta.type === "text_delta"
  ) {
    process.stdout.write(chunk.delta.text);
  }
}
```

---

## Connecting with curl

### Basic text request

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-token" \
  -d '{
    "model": "gemini-2.5-flash",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-token" \
  -d '{
    "model": "gemini-2.5-flash",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Write a haiku."}]
  }'
```

### Vision (base64 image)

```bash
IMAGE_B64=$(base64 -i image.png)

curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-token" \
  -d "{
    \"model\": \"gemini-2.5-flash\",
    \"max_tokens\": 512,
    \"messages\": [{
      \"role\": \"user\",
      \"content\": [
        {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$IMAGE_B64\"}},
        {\"type\": \"text\", \"text\": \"What is in this image?\"}
      ]
    }]
  }"
```

---

## Connecting with Claude Code CLI

Point Claude Code at the router instead of the real Anthropic API:

```bash
ANTHROPIC_BASE_URL=http://localhost:3000 \
ANTHROPIC_API_KEY=your-secret-token \
claude
```

Or set them permanently in your shell profile:

```bash
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_API_KEY=your-secret-token
```

---

## Request Headers

| Header | Values | Description |
|---|---|---|
| `x-api-key` / `Authorization` | `Bearer <token>` | Required. Auth token from `CLIENT_TOKENS` |
| `x-routing-mode` | `flexible` (default), `strict` | Routing mode (see below) |
| `x-lock-model` | `<provider>:<model>`, `clear` | Pin or release model lock (see below) |

---

## Routing Modes

| Mode | Behavior |
|---|---|
| `flexible` (default) | Falls back to any model with the same tier if the exact model is unavailable |
| `strict` | Only routes to the exact model requested; fails if unavailable |

```bash
-H "x-routing-mode: strict"
```

---

## Model Lock

Lock your client token to a specific provider+model for consistent responses across calls.  
Trade-off: **higher consistency, lower resilience** — no failover when locked.

### How it works

1. Make a normal request; check the `x-actual-model` response header to see which provider+model was used.
2. Send that value back as `x-lock-model` to pin to that model.
3. Every subsequent request from this token goes to that exact provider+model — no failover.
4. If the locked model is unavailable, the request fails immediately instead of trying another provider.
5. Lock expires after **1 hour of inactivity** (TTL resets on each use).

### Set a lock

```bash
# Lock to Groq's GPT-OSS model
curl http://localhost:3000/v1/messages \
  -H "x-api-key: your-secret-token" \
  -H "x-lock-model: Groq:openai/gpt-oss-120b" \
  -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-oss-120b", "max_tokens": 512, "messages": [{"role": "user", "content": "Hi"}]}'
```

You can also lock using the `x-actual-model` value from a previous response (`:v1` suffix is automatically stripped):

```bash
-H "x-lock-model: groq:openai/gpt-oss-120b:v1"
```

### Lock in Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    api_key="your-secret-token",
    base_url="http://localhost:3000",
    default_headers={"x-lock-model": "Google:gemini-2.5-flash"},
)
```

### Check current lock

```bash
curl http://localhost:3000/v1/model-lock \
  -H "x-api-key: your-secret-token"
```

Response when locked:
```json
{"locked": true, "provider": "Google", "model": "gemini-2.5-flash"}
```

### Release a lock

Via header in any request:
```bash
-H "x-lock-model: clear"
```

Or via dedicated endpoint:
```bash
curl -X DELETE http://localhost:3000/v1/model-lock \
  -H "x-api-key: your-secret-token"
```

---

## Response Headers

| Header | Example value | Description |
|---|---|---|
| `x-actual-model` | `google:gemini-2.5-flash:v1` | Provider and model that served the request |
| `x-fallback-attempts` | `0`, `1`, `2`... | Number of providers that failed before one succeeded. `0` = first attempt worked. Useful for client-side observability of upstream pressure. |

---

## Available Models

| Model ID to request | Actual provider | Tier |
|---|---|---|
| `gemini-2.5-flash` | Google | balanced |
| `gemini-2.5-flash-lite` | Google | fast |
| `gemini-3.1-flash-lite` | Google | fast |
| `gemma-4-31b-it` | Google | balanced |
| `claude-3-5-sonnet-20241022` | Google (→ gemini-2.5-flash) | balanced |
| `claude-3-haiku-20240307` | Google (→ gemini-2.5-flash-lite) | fast |
| `openai/gpt-oss-120b` | Groq | balanced |
| `meta/llama-4-scout` | Groq | fast |
| `claude-3-sonnet-20240229` | Groq (→ openai/gpt-oss-120b) | balanced |

---

## Health Check

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

No authentication required.

---

## Common Errors

| HTTP | Error type | Cause |
|---|---|---|
| 401 | `authentication_error` | Missing or invalid token |
| 400 | `invalid_request_error` | Missing `model`, `messages`, or `max_tokens` |
| 429 | `rate_limit_error` | All providers for the requested model are rate-limited |
| 500 | `api_error` | All providers failed, or locked provider failed |
| 500 | `overloaded_error` | No healthy providers available |
