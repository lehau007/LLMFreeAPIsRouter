# LLMFreeAPIsRouter

A resilient, high-availability proxy for free-tier LLM APIs with Anthropic-compatible interface.

## Features
- **Anthropic Compatibility:** Drop-in replacement for `/v1/messages`.
- **Smart Routing:** Priority-based routing with health monitoring and latency tracking.
- **Failover:** Automatic retry on 429/5xx errors with provider cooldowns.
- **Streaming:** Full SSE support for streaming tokens.
- **Security:** AES-256-GCM encryption for upstream API keys.

## Quick Start (Windows)

1. **Setup:** Double-click `setup-windows.ps1` (or run it in PowerShell) to install dependencies and create your `.env` file.
2. **Configure:** Open `.env` and set your `MASTER_KEY` (must be at least 32 characters).
3. **Encrypt Keys:** Run `npm run vault` to encrypt your Google or Groq API keys, then paste them into `.env`.
4. **Run:** Double-click `run.bat` or run `npm run dev`.

## Manual Setup

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment:**
   Copy `.env.example` to `.env` and set your `MASTER_KEY` (minimum 32 chars).
   ```bash
   cp .env.example .env
   ```

3. **Secure Your API Keys:**
   Use the built-in Vault utility to encrypt your Google/Groq API keys:
   ```bash
   npm run vault
   ```
   Choose `e` (encrypt), enter your key, and paste the resulting string into your `.env` (e.g., `GOOGLE_API_KEY=salt:iv:authTag:encryptedText`).

4. **Run the Server:**
   ```bash
   # Development (with hot reload)
   npm run dev
   
   # Production
   npm run build
   npm start
   ```

## Usage

### Client Authentication
Send requests with `Authorization: Bearer <token>` or `x-api-key: <token>`. 
Valid tokens are configured in the `CLIENT_TOKENS` environment variable (comma separated).

### Example Request (curl)
```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-token" \
  -d '{
    "model": "claude-3-haiku-20240307",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello, how are you?"}]
  }'
```

### Routing Modes
- `flexible` (default): Remaps requested models to available free models (e.g., `claude-3-haiku` -> `gemini-1.5-flash`).
- `strict`: Only routes to the exact model requested.
Control via header: `x-routing-mode: strict`.

## Docker Deployment
```bash
docker-compose up -d
```

## License
ISC
