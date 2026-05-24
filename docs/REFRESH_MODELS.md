# Refreshing the provider model catalog

This is a **manual** workflow you run inside Claude Code whenever you suspect Google or Groq has added/removed free-tier models. It is not automated. There used to be a scheduled cron version — we dropped it because the value/maintenance ratio for a 1-2 person project is better as an on-demand task.

## When to run it

- After a few weeks have passed and you want to pick up new stable models.
- After seeing repeated 404s on a `meta-*` or `gemini-*` id in your logs (a model was likely renamed or removed).
- Before deploying to a new environment, to make sure the catalog matches reality.

## What it does

```
┌─────────────────────────────────────────────────────────────────────┐
│ scripts/refreshModels.ts                                            │
│   → Calls Google generativelanguage.googleapis.com/v1beta/models    │
│   → Calls Groq api.groq.com/openai/v1/models                        │
│   → Diffs against src/config/providers.ts (PROVIDER_REGISTRY)       │
│   → Filters anything in each provider's `excluded` list             │
│   → Outputs a single JSON document to stdout                        │
└─────────────────────────────────────────────────────────────────────┘
              │
              ▼  (you, in Claude Code)
┌─────────────────────────────────────────────────────────────────────┐
│ For each `added` model: web-search vision support + decide          │
│   if it belongs (skip TTS / image / robotics / preview / specialized)│
│ For each `removed` model: delete entry + any claude-* alias         │
│ Edit src/config/providers.ts                                        │
│ Run `npm run build` to verify                                       │
│ Commit + push                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

The script is intentionally side-effect-free — it discovers and reports, never edits providers.ts. Judgment (which model is worth adding, what tier, whether it's actually multimodal) lives in the human (or LLM-assisted human) layer.

## How to run it

1. Make sure `GOOGLE_API_KEY` and `GROQ_API_KEY` are in `.env` (they need `models.list` scope only — no inference required).

2. Open Claude Code in this repo and paste the prompt below into your conversation. Claude will execute the workflow end-to-end and commit.

3. Review the resulting commit / PR.

## The Claude Code prompt (paste this in)

```
Refresh the provider model catalog for this repo. End-to-end:

1. Run `npm run refresh-models` and parse the JSON from stdout.

2. If `hasChanges` is false, print "No model changes detected." and stop.

3. If `hasChanges` is true:
   a. For every model in providers.<name>.added, use WebSearch to determine:
      - (i) Vision/multimodal input support (search "<modelId> vision multimodal").
      - (ii) Whether it belongs in our free-tier router. SKIP: TTS, image-generation,
        music, robotics, computer-use, deep-research, *-latest aliases, *-001 dated
        pins, anything labelled "preview", moderation classifiers, audio (whisper,
        orpheus), agentic systems (groq/compound), narrow-language specialists.
        KEEP: stable generation-text/multimodal chat models from major families
        (gemini, gemma, llama, qwen, gpt-oss, etc.).
      - Use the `description` field in `details` as a starting hint.

   b. If you decide a model should be NEVER suggested again (TTS variants, etc.),
      add its id to the relevant provider's `excluded` array in providers.ts.
      Otherwise, add it as a new ModelConfig entry. Use these rules:
        - tier: "lite"/"fast"/"instant" -> 'fast'; "pro"/"opus" -> 'powerful';
          otherwise 'balanced'.
        - priority: lower = preferred. Slot new entries near siblings of the same
          tier so the existing fallback order makes sense.
        - capability: 'multimodal' if vision search confirms vision, else 'text'.

   c. For every model in providers.<name>.removed: delete its ModelConfig entry
      AND any claude-* alias whose providerModelId pointed at it.

   d. Run `npm run build`. If it fails, stop and report — do not commit.

   e. Re-run `npm run refresh-models` and confirm hasChanges is now false. If not,
      it means something is still in `added` that you didn't handle — fix it.

   f. Commit the changes to main with message:
      "chore: refresh provider catalog (YYYY-MM-DD)"
      Include the added/removed model list in the body.

4. Hard constraints:
   - Never delete an entry whose providerModelId still appears in `discovered`.
   - Preserve all existing claude-* aliases unless their underlying model is gone.
   - Touch ONLY src/config/providers.ts.
   - Never push if the build failed.

Report at the end: "No changes", or "Updated providers.ts: added=[...], removed=[...], excluded=[...]".
```

## What the script outputs (for reference)

```json
{
  "timestamp": "2026-05-23T12:34:56.789Z",
  "hasChanges": true,
  "providers": {
    "Google": {
      "configured": ["gemini-2.5-flash", ...],
      "discovered": ["gemini-2.5-flash", "gemini-3-pro-preview", ...],
      "added": ["gemini-3-pro-preview"],
      "removed": [],
      "details": {
        "gemini-3-pro-preview": {
          "displayName": "Gemini 3 Pro Preview",
          "description": "...",
          "inputTokenLimit": 1048576,
          "supportedGenerationMethods": ["generateContent", "streamGenerateContent"]
        }
      }
    },
    "Groq": { "configured": [...], "discovered": [...], "added": [], "removed": [], "details": {} }
  }
}
```

If a provider has `"error": "GOOGLE_API_KEY not set"` (or similar), the script saw that the env var was missing — fix `.env` and rerun.

## Running the script alone (no LLM in the loop)

```bash
npm run refresh-models > /tmp/refresh.json
cat /tmp/refresh.json | jq '.providers | to_entries[] | {provider:.key, added:.value.added, removed:.value.removed}'
```

If you only want the discovery without involving Claude, this is the path. You then edit `src/config/providers.ts` by hand.
