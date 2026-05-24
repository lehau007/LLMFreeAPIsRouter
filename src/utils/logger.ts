import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const DB_PATH = path.join(LOGS_DIR, 'requests.db');
const RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT    NOT NULL,
        request_model TEXT  NOT NULL,
        provider    TEXT    NOT NULL,
        provider_model TEXT NOT NULL,
        latency_ms  INTEGER NOT NULL,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        success     INTEGER NOT NULL,
        error_message TEXT,
        key_index   INTEGER,
        fallback_attempts INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp);
    `);
    // Idempotent migrations for DBs created before key_index / fallback_attempts existed.
    const cols = new Set((db.prepare(`PRAGMA table_info(request_logs)`).all() as { name: string }[]).map(c => c.name));
    if (!cols.has('key_index')) db.exec(`ALTER TABLE request_logs ADD COLUMN key_index INTEGER`);
    if (!cols.has('fallback_attempts')) db.exec(`ALTER TABLE request_logs ADD COLUMN fallback_attempts INTEGER`);
  }
  return db;
}

export interface RequestLog {
  timestamp: string;
  requestModel: string;
  provider: string;
  providerModel: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  success: boolean;
  errorMessage?: string;
  keyIndex?: number;
  fallbackAttempts?: number;
}

const insertStmt = () => getDb().prepare(`
  INSERT INTO request_logs
    (timestamp, request_model, provider, provider_model, latency_ms, input_tokens, output_tokens, success, error_message, key_index, fallback_attempts)
  VALUES
    (@timestamp, @requestModel, @provider, @providerModel, @latencyMs, @inputTokens, @outputTokens, @success, @errorMessage, @keyIndex, @fallbackAttempts)
`);

let _insert: ReturnType<Database.Database['prepare']> | null = null;

export function logRequest(entry: RequestLog): void {
  try {
    if (!_insert) _insert = insertStmt();
    _insert.run({
      ...entry,
      success: entry.success ? 1 : 0,
      inputTokens: entry.inputTokens ?? null,
      outputTokens: entry.outputTokens ?? null,
      errorMessage: entry.errorMessage ?? null,
      keyIndex: entry.keyIndex ?? null,
      fallbackAttempts: entry.fallbackAttempts ?? null,
    });
  } catch (err) {
    console.error('[Logger] Failed to write log:', err);
  }
}

export function cleanupOldLogs(): void {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    const result = getDb().prepare(`DELETE FROM request_logs WHERE timestamp < ?`).run(cutoff);
    console.log(`[Logger] Cleaned up ${result.changes} log entries older than ${RETENTION_DAYS} days.`);
  } catch (err) {
    console.error('[Logger] Cleanup failed:', err);
  }
}
