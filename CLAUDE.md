# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LLMFreeAPIsRouter is a proxy server exposing an Anthropic-compatible `/v1/messages` API while routing requests to free-tier providers (Google Gemini, Groq). It handles provider selection, dynamic priority demotion, per-key cooldowns, proactive RPM/RPD gating, failover, and streaming—all with AES-256-GCM encrypted API key storage and multi-key round-robin per provider.

## Commands

```bash
npm run dev             # Development server with hot reload (nodemon)
npm run build           # Compile TypeScript → dist/
npm start               # Run compiled production build
npm run vault           # CLI for encrypting/decrypting provider API keys
npm run refresh-models  # Diff live provider catalogs vs PROVIDER_REGISTRY → stdout JSON
docker-compose up -d    # Build and run in Docker
```

No lint or test scripts are configured.

## Catalog refresh workflow

`src/config/providers.ts` is hand-maintained but kept in sync with upstream model lists via a manual playbook (see [docs/REFRESH_MODELS.md](docs/REFRESH_MODELS.md)). The script `scripts/refreshModels.ts` is **discovery-only** — it never mutates `providers.ts`. Judgment about which model belongs (vision support, tier, preview-vs-GA) lives in the human/LLM layer.

Each provider entry has an `excluded: string[]` field for `providerModelId`s we explicitly never want — TTS, image-gen, robotics, preview, moderation classifiers, volatile aliases. The refresh script filters these out of `added` so they don't get re-suggested on every run.

When the user asks to "refresh models" / "check for new models" / "update the model catalog", follow the playbook prompt in `docs/REFRESH_MODELS.md`.

## Architecture

### Request Flow

```
Client (Anthropic SDK / curl)
  → Auth middleware (Bearer token or x-api-key)
  → /v1/messages route handler (src/routes/messages.ts)
  → Router (src/router/index.ts)
      → selectProviders():
          - strict (exact model) or flexible (tier-equivalent) mode
          - filter: provider.isAvailable() (health flag)
          - filter: provider.hasAvailableKey(model) — per-(model, keyIndex) cooldown
          - filter: hasAvailableKeyForLimits(...) — per-key RPM/RPD sliding window
          - sort: (priority + dynamicPenalty) asc, tiebreak latency-EMA desc
          - penalty bypassed when lockedTarget is set
      → routeChat() or routeStreamChat(), counting attempts into RouteContext
  → Provider adapter (src/providers/*.ts)
      → nextKey() → round-robin one key (sets lastKeyIndex)
      → JIT-decrypted key was already prepared by config layer; provider just reads
      → Translate Anthropic format → provider format
      → Call upstream API; on error, attach error.keyIndex and throw
      → Translate response back → Anthropic format
  → Router records: recordRequest (rate-limit window), recordSuccess / recordFailure
                    (per-key cooldown), recordPenaltyDecay / recordRateLimitHit
  → Client receives response or SSE stream + headers x-actual-model, x-fallback-attempts
```

### Key Modules

**`src/router/index.ts`** — Core logic: provider selection, health gating, failover, streaming pre-commit buffering. Owns the **dynamic priority penalty** registry (`recordRateLimitHit`/`recordPenaltyDecay`/`getPenalty`): a 429 on `(provider, model)` adds +3 penalty (cap 10) that adds to the configured priority during sort; decays 1 step every 2 minutes. Lock mode bypasses the penalty. Exports `RouteContext { attempts }` which the routes layer threads through to emit `x-fallback-attempts`.

**`src/providers/`** — All providers extend `BaseProvider` (abstract class in `base.ts`) implementing `chat()` and `streamChat()`. Health state (latency EMA, consecutive failures) lives on each provider instance. Cooldown is **per `(modelId, keyIndex)`** via `setCooldown / isCooledDown / hasAvailableKey` — a 429 on one key/model only locks that pair, not the whole provider. `nextKey()` returns `{key, index}` for round-robin and sets `lastKeyIndex` so the router can attribute requests for rate-limit accounting.
- `openai-like.ts` is a shared base for Groq (and any OpenAI-compatible provider)
- `google.ts` handles the Gemini format translation separately
- Both providers attach `error.keyIndex` to thrown errors so the router can scope failure handling.

**`src/config/providers.ts`** — Builds provider instances from env vars. `decryptIfNeeded` parses **comma-separated** `*_API_KEY` into `apiKeys: string[]`; each element is independently auto-detected as plain or `salt:iv:authTag:ciphertext` and decrypted. Optional per-provider RPM/RPD env vars (`GOOGLE_RPM`, `GOOGLE_RPD`, `GROQ_RPM`, `GROQ_RPD`) become `ProviderConfig.rpm/rpd`. Model mappings (e.g., `claude-3-haiku → gemini-2.5-flash-lite`) are defined here.

**`src/utils/rateLimits.ts`** — Sliding-window counters per `(providerName, modelId, keyIndex)` with separate 1-minute and 24-hour windows. `canMakeRequest` / `hasAvailableKeyForLimits` are called by the router during `selectProviders` to skip saturated candidates **before** dispatching. `recordRequest` is called optimistically on every attempt (success or failure) so windows track upstream load accurately.

**`src/utils/encryption.ts`** — AES-256-GCM with PBKDF2 key derivation (100k iterations). Encrypted format: `salt:iv:authTag:ciphertext` (all base64). The `npm run vault` CLI uses this for key management.

**`src/utils/logger.ts`** — SQLite request log at `logs/requests.db`. Schema includes `key_index` and `fallback_attempts` columns for per-key load distribution and failover-cascade analysis. Schema migrates via idempotent `ALTER TABLE` on first open.

**`src/middleware/auth.ts`** — Validates `Authorization: Bearer <token>` or `x-api-key` header against `CLIENT_TOKENS` env var.

### Routing Modes

Set via request header `x-routing-mode: strict | flexible` (default: `flexible`).
- **strict**: Only providers with an exact model match are eligible.
- **flexible**: Falls back to any provider with a compatible capability tier.

### Provider Health & Failover

- **Per-(model, keyIndex) cooldown**: 60s on 429, 30s on 5xx/timeout. Other keys/models of the same provider remain usable.
- **Dynamic priority penalty**: 429s on `(provider, model)` add +3 (cap 10) to the configured priority during sort; decays 1 step / 2 min back to 0.
- **Proactive RPM/RPD gating** (optional): when `*_RPM` / `*_RPD` env vars are set, sliding-window counters skip saturated keys before dispatching.
- 3 consecutive non-rate-limit failures mark the whole provider unhealthy (escape hatch for total outage).
- Latency tracked via exponential moving average; used as sort tiebreak.
- For streaming: responses are buffered until the first token is confirmed; failover is transparent to the client if it happens before streaming begins.

### Multi-key per provider

`*_API_KEY` env vars accept a single key or a comma-separated list. Each element may be plain or vault-encrypted independently. `BaseProvider.nextKey()` round-robins through them; each `(model, keyIndex)` has its own cooldown and rate-limit window. Use multiple free-tier accounts to multiply effective throughput.

## Environment Variables

```bash
PORT=3000
NODE_ENV=development
MASTER_KEY=<min 32 chars>          # Root key for AES-256-GCM decryption
CLIENT_TOKENS=token1,token2        # Comma-separated valid client auth tokens

# One key or comma-separated keys; each element plain or vault-encrypted
GOOGLE_API_KEY=k1,k2,k3
GROQ_API_KEY=<plain or encrypted>

# Optional proactive rate-limit gating per provider (unset = no gating)
GOOGLE_RPM=15
GOOGLE_RPD=1500
GROQ_RPM=30
GROQ_RPD=14400

LOG_RETENTION_DAYS=7
GRAFANA_PASSWORD=admin
```

Copy `.env.example` to `.env` and run `npm run vault` to encrypt keys before adding them.

## Response Headers

- `x-actual-model: <provider>:<model>:v1` — which provider/model served the request.
- `x-fallback-attempts: <N>` — number of providers that failed before one succeeded (`0` = first try worked).
- Streaming uses SSE: `message_start`, `content_block_delta`, `message_stop`, `error` events. Both headers above are set before the first event flushes.

## TypeScript Config

Target: ES2022, module: CommonJS, strict mode on, output to `dist/`. Source root is `src/`.

## Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
