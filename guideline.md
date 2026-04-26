# Development Guidelines: LLMFreeAPIsRouter

## Tech Stack
- **Runtime:** Node.js (LTS)
- **Language:** TypeScript
- **Web Framework:** Express.js
- **API Format:** Anthropic Messages API (v1)
- **Encryption:** Node.js `crypto` module (AES-256-GCM)
- **Testing:** Jest (recommended)
- **Containerization:** Docker

## Coding Standards

### 1. Type Safety
- Always define interfaces for Provider requests and responses.
- Avoid the use of `any`; use strict typing for all routing logic and metadata handling.

### 2. Provider Implementation
- Every new provider must implement the `IProvider` interface.
- Ensure format translation is bidirectional (Anthropic -> Native -> Anthropic).
- Handle both streaming and non-streaming modes.

### 3. Error Handling
- Never expose upstream API keys in error messages.
- Use the `Error Normalizer` to map upstream errors to standard Anthropic error types.
- Log internal errors with enough context for debugging but ensure zero leakage of PII or secrets.

### 4. Security
- Use the Master Key only for JIT decryption.
- Nonces for encryption MUST be unique (96-bit for GCM).
- Do not commit `.env` files or decrypted provider keys to version control.

## Project Structure (Conceptual)
```text
src/
├── adapters/          # Provider-specific implementations (Google, Groq, etc.)
├── core/              # Router logic, admission gate, failover engine
├── security/          # Encryption, vault, and JIT decryption logic
├── middleware/        # Auth, logging, and error normalization
├── utils/             # SSE helpers, format translators, types
├── index.ts           # Server entry point
└── config/            # YAML/Env configuration loader
```

## Naming Conventions
- **Providers:** CamelCase (e.g., `GoogleGeminiAdapter`).
- **Headers:** Use `x-` prefix for custom headers (e.g., `x-routing-mode`, `x-actual-model`).
- **Internal Tokens:** Must start with `freellmapi-v1-`.

## Testing Strategy
- **Unit Tests:** For encryption logic and format translators.
- **Integration Tests:** For the Router selection logic using mocked provider responses.
- **E2E Tests:** Using a mock client to verify SSE streaming and failover behavior.
