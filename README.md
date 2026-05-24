# LLMFreeAPIsRouter

A self-hosted proxy that exposes an **Anthropic-compatible `/v1/messages` API** while routing requests to free-tier providers (Google Gemini, Groq). Supports streaming, vision, automatic failover, model locking, and observability via Grafana.

---

## Features

- **Anthropic-compatible** — drop-in replacement for `https://api.anthropic.com`; works with any Anthropic SDK client
- **Multi-provider routing** — Google Gemini and Groq; priority + latency-EMA based selection
- **Automatic failover** — tries next provider transparently; streaming failover happens before any token reaches the client
- **Multi-key per provider** — comma-separated API keys with round-robin; cooldowns are per `(provider, model, key)` so a 429 on one key doesn't lock out the rest
- **Dynamic priority demotion** — a model that gets 429s sinks in the fallback chain and recovers automatically (penalty decays 1 step every 2 minutes, cap 10)
- **Proactive RPM/RPD gating** — optional per-provider env vars; saturated keys are skipped *before* hitting the upstream
- **Model lock** — pin a client token to a specific provider+model for consistent responses across calls
- **Vision support** — multimodal requests routed only to capable models; accepts base64 and URL images
- **Tier-aware flexible routing** — fallback stays within the same capability tier (`fast` / `balanced` / `powerful`)
- **Streaming** — full SSE with 15s stall-timeout detection per chunk
- **Encrypted key storage** — AES-256-GCM via `npm run vault`
- **Observability** — request logs in SQLite (incl. `key_index` + `fallback_attempts`); `x-fallback-attempts` response header; Grafana datasource pre-provisioned

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
MASTER_KEY=your_super_secret_master_key_at_least_32_chars
CLIENT_TOKENS=your-secret-token

# Single or comma-separated (each element may be plain or vault-encrypted)
GOOGLE_API_KEY=key1,key2,key3
GROQ_API_KEY=your_groq_api_key

# Optional: proactive rate-limit gating per provider
GOOGLE_RPM=15
GOOGLE_RPD=1500
GROQ_RPM=30

LOG_RETENTION_DAYS=7        # optional, default 7
GRAFANA_PASSWORD=admin       # optional, default admin
```

### 3. (Optional) Encrypt API keys

```bash
npm run vault
# Select e → encrypt → paste the result back into .env
```

### 4. Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start

# Docker (router + Grafana)
docker-compose up -d
```

After starting → open [CONNECTION_GUIDE.md](CONNECTION_GUIDE.md) for client setup.

---

## Available Models

### Google (Gemini API)

| Request model | Maps to | Tier | Capability |
|---|---|---|---|
| `gemini-2.5-flash` | gemini-2.5-flash | balanced | multimodal |
| `gemini-2.5-flash-lite` | gemini-2.5-flash-lite | fast | multimodal |
| `gemini-3.1-flash-lite` | gemini-3.1-flash-lite | fast | multimodal |
| `gemma-4-31b-it` | gemma-4-31b-it | balanced | text |
| `claude-3-5-sonnet-20241022` | gemini-2.5-flash | balanced | multimodal |
| `claude-3-haiku-20240307` | gemini-2.5-flash-lite | fast | multimodal |

### Groq

| Request model | Maps to | Tier | Capability |
|---|---|---|---|
| `openai/gpt-oss-120b` | openai/gpt-oss-120b | balanced | text |
| `meta/llama-4-scout` | meta/llama-4-scout | fast | multimodal |
| `claude-3-sonnet-20240229` | openai/gpt-oss-120b | balanced | text |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Server listen port |
| `MASTER_KEY` | Yes | — | Min 32 chars; used to decrypt encrypted API keys |
| `CLIENT_TOKENS` | Yes | — | Comma-separated valid auth tokens |
| `GOOGLE_API_KEY` | Yes* | — | One key, or comma-separated keys. Each element may be plain or vault-encrypted |
| `GROQ_API_KEY` | Yes* | — | Same format as `GOOGLE_API_KEY` |
| `GOOGLE_RPM` / `GOOGLE_RPD` | No | — | Per-provider rate-limit gating (requests/minute, requests/day). Unset = no gating |
| `GROQ_RPM` / `GROQ_RPD` | No | — | Same as above for Groq |
| `LOG_RETENTION_DAYS` | No | `7` | Days to keep SQLite request logs |
| `GRAFANA_PASSWORD` | No | `admin` | Grafana admin password |

*At least one provider key is required.

---

## Architecture

```
Client (Anthropic SDK / curl)
  → Auth middleware (Bearer token or x-api-key)
  → /v1/messages route handler
  → Router
      → selectProviders(): strict (exact model) or flexible (tier-equivalent)
        or locked (single pinned provider+model, no failover)
      → Tie-break: configured priority → latency EMA → LRU
      → routeChat() or routeStreamChat()
  → Provider adapter (Google / Groq)
      → JIT-decrypt API key
      → Translate Anthropic format → provider format
      → Call upstream API (with AbortController timeout)
      → Translate response → Anthropic format
  → Client receives JSON or SSE stream
```

**Key source files:**

| File | Role |
|---|---|
| `src/router/index.ts` | Provider selection, failover, dynamic priority penalty, `RouteContext.attempts` |
| `src/providers/base.ts` | Health state, latency EMA, multi-key round-robin (`nextKey`), per-`(model, keyIndex)` cooldown |
| `src/providers/google.ts` | Gemini format translation; attaches `keyIndex` to thrown errors |
| `src/providers/openai-like.ts` | Shared base for Groq (OpenAI-compatible wire format) |
| `src/utils/rateLimits.ts` | Sliding-window RPM/RPD counters keyed by `(provider, model, keyIndex)` |
| `src/config/providers.ts` | Builds provider instances from env; model ID mappings; parses comma-separated keys |
| `src/utils/modelLock.ts` | In-memory per-token model lock with 1-hour TTL |
| `src/utils/encryption.ts` | AES-256-GCM with PBKDF2 (100k iterations) |
| `src/middleware/auth.ts` | Validates Bearer / x-api-key against CLIENT_TOKENS |

---

## Observability

Start with Docker to include Grafana:

```bash
docker-compose up -d
```

- **Router** → http://localhost:3000
- **Grafana** → http://localhost:3001 (user: `admin`, password: `GRAFANA_PASSWORD`)

The `RequestLogs` SQLite datasource is pre-configured. Useful columns: `provider`, `provider_model`, `key_index`, `fallback_attempts`, `latency_ms`, `success`. Example queries:

```sql
-- Verify round-robin balancing across keys
SELECT provider, key_index, COUNT(*) AS reqs
FROM request_logs WHERE success = 1
GROUP BY provider, key_index;

-- Failover hotspots: which models cause cascades?
SELECT request_model, AVG(fallback_attempts) AS avg_fallbacks, COUNT(*) AS total
FROM request_logs GROUP BY request_model ORDER BY avg_fallbacks DESC;
```

Logs older than `LOG_RETENTION_DAYS` days are deleted on each server start.

---

## Development

```bash
npm run dev       # Dev server with hot reload (nodemon)
npm run build     # Compile TypeScript → dist/
npm start         # Run compiled build
npm run vault     # CLI for encrypting / decrypting API keys
```

No lint or test scripts are configured.

---

## License

ISC
