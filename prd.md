# Product Requirements Document (PRD): LLMFreeAPIsRouter

## 1. Product Overview & Goals

### 1.1 Vision
**LLMFreeAPIsRouter** is a high-performance, resilient, and **Anthropic-compatible** proxy server designed to unify access to various free Tier LLM providers (e.g., Google, Groq, Cerebras, OpenRouter, HuggingFace). It abstracts the complexities of multi-provider management, rate limiting, and failover, providing developers with a single, reliable endpoint for their AI-driven applications using the Anthropic Messages API format.

### 1.2 Target Audience
- Developers and hobbyists building LLM applications on a budget.
- Researchers and experimenters who need to access multiple models through a standard interface.
- Application builders requiring high availability through redundant free-tier API integrations.

### 1.3 Primary Objectives
- **Standardization:** Provide a drop-in replacement for Anthropic API endpoints.
- **Reliability:** Ensure maximum uptime by intelligently routing around rate limits and provider outages.
- **Efficiency:** Minimize latency and overhead in the routing process.
- **Security:** Maintain strict security standards for API key management and request handling.

---

## 2. Core Features

### 2.1 Anthropic Compatibility
- **Endpoint Support:** Primary support for `/v1/messages`.
- **Streaming:** Full support for Server-Sent Events (SSE) to stream tokens to clients according to Anthropic's streaming format.
- **Parameters:** Support for standard Anthropic parameters:
    - `model` (string, required)
    - `messages` (array, required)
    - `max_tokens` (integer, required)
    - `system` (string, optional)
    - `temperature` (float, optional)
    - `stream` (boolean, optional)

### 2.2 Smart Routing Logic
- **Routing Mode Policy:** Supports two routing modes. Precedence: Request header `x-routing-mode` overrides server-side `DEFAULT_ROUTING_MODE` (which defaults to `flexible`) unless `ALLOW_MODE_OVERRIDE` is set to false in the global config.
    - `strict`: Only routes to the exact model requested; returns an error if unavailable.
    - `flexible`: Allows remapping to equivalent models in the same capability tier.
- **Response Metadata:** Every successful response MUST include an `x-actual-model` header.
    - **Schema:** `provider:model:version` (e.g., `google:gemini-1.5-pro:v1`, `groq:llama-3-70b:v1`).
- **All-Limits Admission Gate:** A model/provider is only selected if it passes a comprehensive check against *all* applicable limits, including Key-level quotas, Provider-level RPM/TPM, and model-specific constraints.
- **Model Capability Mapping:** (In `flexible` mode) Client-requested model names are treated as capability/tier filters. If the requested model (e.g., "claude-3-haiku") is unavailable, the router maps the request to an equivalent healthy model (e.g., a fast-tier Llama-3 instance).
- **Routing Determinism (Tie-Breaking):** When multiple candidates pass the admission gate, the tie-break order is:
    1. Highest configured Priority.
    2. Lowest historical latency (Exponential Moving Average).
    3. Least Recently Used (LRU).
- **Health Monitoring:** Tracks the status of each provider and API key in real-time.
- **Rate Limit Awareness:** Dynamically tracks remaining quotas and resets for each provider to prevent `429 Too Many Requests` errors.

### 2.3 Resilience & Failover
- **Automatic Retries:** If a provider fails (429 or 5xx), the router automatically attempts the request with the next best provider.
- **Streaming Resilience (Buffered Pre-Stream):** For streamed requests, the proxy buffers the response until the Time-To-First-Token (TTFT) is reached. If a failure occurs *before* the first token is emitted, the proxy transparently fails over to the next provider.
- **Fail-Fast Mid-Stream:** If a connection fails *after* tokens have begun streaming to the client, the proxy terminates the stream immediately.
- **On-Wire Error Contract:** Before termination of a mid-stream failure, the proxy MUST emit a standard Anthropic SSE `event: error`.
    - **Schema:** `data: {"type": "error", "error": {"type": "<normalized_type>", "message": "<detailed_reason>"}}`
- **Error Normalization Table:** Adapters MUST map upstream failures to these standard Anthropic types:
    | Upstream State | Anthropic error.type | Description |
    | :--- | :--- | :--- |
    | 429 / Quota Exceeded | `rate_limit_error` | Model/Key rate limit reached. |
    | 502 / 503 / 504 | `overloaded_error` | Upstream provider is down or overloaded. |
    | Timeout / Conn. Reset | `api_error` | Communication failure with upstream. |
    | 400 / 422 | `invalid_request_error` | Client request was rejected by upstream. |
- **Exponential Backoff:** Implements retry logic with jitter to avoid slamming recovering providers.
- **Provider Cooldowns:** ANY `429` or `5xx` response MUST trigger an immediate cooldown for that specific provider/key combination. Cooldowns also apply to persistent connection errors or timeouts.

---

## 3. Security & API Key Management

### 3.1 Key Storage & Operations
- **AES-256-GCM Encryption:** Provider API keys are stored locally as encrypted strings using AES-256-GCM.
- **Master Key Root of Trust:** A `MASTER_KEY` environment variable must be provided at runtime. 
- **Operational Acceptance Criteria:**
    - **Fail-Closed Startup:** The proxy MUST refuse to start and exit with an error if `MASTER_KEY` is missing, empty, or fails a checksum/validation test.
    - **Nonce Uniqueness:** Every encryption operation MUST use a unique, cryptographically secure 96-bit nonce (IV), stored prefixed to the ciphertext.
    - **Key Rotation:** The system must support re-encrypting all provider keys with a new `MASTER_KEY` via a provided CLI utility to ensure zero-downtime rotation.
- **Just-in-Time Decryption:** Keys are decrypted only when a request is actively being prepared for a specific upstream provider.

### 3.2 Client Authentication
- **Canonical Authentication:** Standard `Authorization: Bearer <token>` is the primary and recommended method for client authentication.
- **Compatibility Mode:** The `x-api-key` header is supported as a secondary method to provide drop-in compatibility for existing Anthropic clients.
- **Internal Token Format:** Proxy tokens follow the format `freellmapi-v1-xxxxxxxx`.
- **Token Scoping:** Support for different access levels or usage quotas per client token.

### 3.3 Leakage Prevention
- **Sanitized Logging:** Ensure API keys and sensitive headers are never logged.
- **Secure Proxies:** Use industry-standard practices for forwarding requests to upstream providers.

---

## 4. Technical Architecture

### 4.1 Server Stack
- **Framework:** Express.js (Node.js) for high-concurrency request handling.
- **Protocol:** HTTP/HTTPS.
- **Default Port:** 3001.

### 4.2 Modular Design
- **Router Core:** Central logic for provider selection, rate limit tracking, and failover orchestration.
- **Provider Adapters:** Modular plugins for each upstream API (Google SDK, Groq SDK, etc.), translating standard **Anthropic requests** into provider-specific formats if necessary.

---

## 5. Provider Integration & Onboarding

### 5.1 Standardized Provider Interface
New providers must implement a standard interface:
- `initialize()`: Setup SDK or connection parameters.
- `execute(request)`: Execute the chat completion/messages request.
- `stream(request)`: Handle streaming responses.
- `checkHealth()`: Verify API availability and remaining quota.

### 5.2 Supported Initial Providers
- Google (Gemini)
- Groq (Llama, Mixtral)
- Cerebras
- OpenRouter (Unified free tier)
- HuggingFace (Inference API)

### 5.3 Provider Onboarding Checklist
To integrate a new provider, the following criteria must be met:
- **Format Translation:** Implementation of bidirectional translation between Anthropic Messages format and the provider's native format.
- **Rate-Limit Metadata:** The adapter must correctly extract and track RPM/TPM metadata from response headers.
- **Health Probing:** The provider must support a lightweight health-check request to verify API availability and current quota status.
- **Stream Conformance:** The provider's SSE output must be validated against Anthropic's streaming event schema.
- **Error Handling:** Explicit mapping of provider-specific errors (e.g., specific 4xx/5xx codes) to standardized proxy responses.

---

## 6. Non-Functional Requirements

### 6.1 Performance
- **Latency Overhead:** The proxy should add < 50ms of overhead to any request (excluding upstream provider latency).
- **Concurrency:** Support for at least 100 concurrent requests on base hardware.

### 6.2 Observability
- **Detailed Metrics:** Log routing decisions, provider success/fail rates, and latency per provider.
- **Health Dashboard:** (Future) A simple web-based or CLI-based view of the current pool status.

---

## 7. Deployment Guidelines

### 7.1 Containerization
- **Docker:** Official `Dockerfile` provided for consistent deployments across environments.
- **Docker Compose:** Simplifies setup with environment variable management.

### 7.2 Configuration
- Configuration via `config.yaml` or environment variables for provider priorities, retry limits, and cooldown periods.

### 7.3 Hosting Recommendations
- Can be self-hosted on a VPS, Raspberry Pi, or deployed to cloud platforms like Google Cloud Run or AWS App Runner.
