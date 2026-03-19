#!/usr/bin/env node
/**
 * Google Sheets helper for NanoClaw task-bot
 *
 * Usage:
 *   SPREADSHEET_ID=<id> node /app/gsheets.js get-tasks
 *   SPREADSHEET_ID=<id> node /app/gsheets.js update-status "タスク名の一部" "完了"
 *   SPREADSHEET_ID=<id> node /app/gsheets.js add-task "タスク名" "カテゴリ" "優先度" "期限" "担当者"
 *
 * Credentials: /workspace/extra/gsheets/credentials.json (service account JSON)
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';

// Column indices (0-based, matching the reference bot schema)
const COL_ID = 0;
const COL_TASK_NAME = 1;
const COL_CATEGORY = 2;
const COL_PRIORITY = 3;
const COL_DUE_DATE = 4;
const COL_ASSIGNEE = 5;
const COL_STATUS = 6;
const COL_PROGRESS = 7;
const COL_UPDATED_AT = 8;

const DONE_STATUSES = ['完了', '中止', 'done', 'canceled', 'cancelled'];

// Config
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'タスク一覧';
const CREDENTIALS_PATH = '/workspace/extra/gsheets/credentials.json';
const SPREADSHEET_ID_FILE = '/workspace/group/.spreadsheet_id';

function resolveSpreadsheetId() {
  if (SPREADSHEET_ID) return SPREADSHEET_ID;
  if (existsSync(SPREADSHEET_ID_FILE)) {
    return readFileSync(SPREADSHEET_ID_FILE, 'utf-8').trim();
  }
  console.error(
    'エラー: SPREADSHEET_ID が設定されていません。' +
      '.env で SPREADSHEET_ID を設定するか、' +
      '/workspace/group/.spreadsheet_id ファイルを作成してください。',
  );
  process.exit(1);
}

function getAuth() {
  if (!existsSync(CREDENTIALS_PATH)) {
    console.error(
      'エラー: Google認証情報が見つかりません。\n' +
        `ホスト側に ~/.config/nanoclaw/gsheets/credentials.json を配置し、\n` +
        `mount-allowlist.json に ~/.config/nanoclaw/gsheets を追加してください。`,
    );
    process.exit(1);
  }
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

async function getAllRows(spreadsheetId) {
  const sheets = await getSheets();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A2:I`,
  });
  return response.data.values || [];
}

async function getTasks() {
  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);
  const tasks = rows
    .map((row, idx) => ({
      rowIndex: idx + 2, // 1-based, row 1 is header
      id: row[COL_ID] || '',
      name: row[COL_TASK_NAME] || '',
      category: row[COL_CATEGORY] || '',
      priority: row[COL_PRIORITY] || '中',
      dueDate: row[COL_DUE_DATE] || '',
      assignee: row[COL_ASSIGNEE] || '',
      status: row[COL_STATUS] || '未着手',
      progress: row[COL_PROGRESS] || '',
      updatedAt: row[COL_UPDATED_AT] || '',
    }))
    .filter((t) => t.name && !DONE_STATUSES.includes(t.status));

  console.log(JSON.stringify(tasks, null, 2));
}

async function updateStatus(taskHint, newStatus) {
  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);

  // Stage 1: exact substring match
  let matchRow = -1;
  let matchName = '';

  for (let i = 0; i < rows.length; i++) {
    const name = rows[i][COL_TASK_NAME] || '';
    if (name.includes(taskHint)) {
      matchRow = i + 2;
      matchName = name;
      break;
    }
  }

  // Stage 2: word-overlap fuzzy search
  if (matchRow === -1) {
    const hintWords = taskHint
      .toLowerCase()
      .split(/[\s　]+/)
      .filter(Boolean);
    let bestScore = 0;
    for (let i = 0; i < rows.length; i++) {
      const name = (rows[i][COL_TASK_NAME] || '').toLowerCase();
      let score = 0;
      for (const word of hintWords) {
        if (name.includes(word)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        matchRow = i + 2;
        matchName = rows[i][COL_TASK_NAME] || '';
      }
    }
    if (bestScore === 0) {
      console.error(`タスクが見つかりません: "${taskHint}"`);
      process.exit(1);
    }
    console.error(
      `あいまい検索でマッチ: "${taskHint}" → "${matchName}" (スコア: ${bestScore})`,
    );
  }

  const sheets = await getSheets();
  const tz = process.env.TZ || 'Asia/Tokyo';
  const now = new Date().toLocaleString('ja-JP', { timeZone: tz });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!G${matchRow}:I${matchRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[newStatus, '', now]],
    },
  });

  console.log(`✅ "${matchName}" のステータスを "${newStatus}" に更新しました`);
}

async function addTask(name, category, priority, dueDate, assignee) {
  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);
  const newId = `T${String(rows.length + 1).padStart(4, '0')}`;
  const tz = process.env.TZ || 'Asia/Tokyo';
  const now = new Date().toLocaleString('ja-JP', { timeZone: tz });

  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        [
          newId,
          name,
          category || '',
          priority || '中',
          dueDate || '',
          assignee || '',
          '未着手',
          '',
          now,
        ],
      ],
    },
  });

  console.log(`✅ タスク "${name}" (ID: ${newId}) を追加しました`);
}

// CLI dispatch
const [, , command, ...args] = process.argv;

try {
  if (command === 'get-tasks') {
    await getTasks();
  } else if (command === 'update-status') {
    const [taskHint, newStatus] = args;
    if (!taskHint || !newStatus) {
      console.error('Usage: gsheets.js update-status <task-hint> <status>');
      process.exit(1);
    }
    await updateStatus(taskHint, newStatus);
  } else if (command === 'add-task') {
    const [name, category, priority, dueDate, assignee] = args;
    if (!name) {
      console.error(
        'Usage: gsheets.js add-task <name> [category] [priority] [due-date] [assignee]',
      );
      process.exit(1);
    }
    await addTask(name, category, priority, dueDate, assignee);
  } else {
    console.error(
      'コマンド: get-tasks | update-status <hint> <status> | add-task <name> [category] [priority] [due] [assignee]',
    );
    process.exit(1);
  }
} catch (err) {
  console.error('エラー:', err.message);
  process.exit(1);
}
