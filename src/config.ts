import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CLAUDE_CODE_MODEL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const CLAUDE_CODE_MODEL =
  process.env.CLAUDE_CODE_MODEL || envConfig.CLAUDE_CODE_MODEL || '';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Task bot configuration
const taskBotEnv = readEnvFile([
  'TASK_CHANNELS',
  'REPORT_CHANNEL',
  'SPREADSHEET_ID',
  'WEEKLY_REPORT_CRON',
  'DAILY_SCAN_CRON',
  'TASK_BOT_MODEL',
]);

/** Comma-separated Discord channel IDs to monitor for task messages (no @mention needed) */
export const TASK_CHANNELS: string[] = (
  process.env.TASK_CHANNELS ||
  taskBotEnv.TASK_CHANNELS ||
  ''
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Discord channel ID where the weekly progress report is posted */
export const REPORT_CHANNEL: string =
  process.env.REPORT_CHANNEL || taskBotEnv.REPORT_CHANNEL || '';

/** Google Spreadsheet ID for task management */
export const SPREADSHEET_ID: string =
  process.env.SPREADSHEET_ID || taskBotEnv.SPREADSHEET_ID || '';

/** Cron expression for the weekly report (default: every Sunday at 9:00 AM) */
export const WEEKLY_REPORT_CRON: string =
  process.env.WEEKLY_REPORT_CRON ||
  taskBotEnv.WEEKLY_REPORT_CRON ||
  '0 9 * * 0';

/** Cron expression for the daily task scan (default: every day at 22:00) */
export const DAILY_SCAN_CRON: string =
  process.env.DAILY_SCAN_CRON || taskBotEnv.DAILY_SCAN_CRON || '0 22 * * *';

/** Model override for the task-bot group (default: empty = use global CLAUDE_CODE_MODEL) */
export const TASK_BOT_MODEL: string =
  process.env.TASK_BOT_MODEL || taskBotEnv.TASK_BOT_MODEL || '';
