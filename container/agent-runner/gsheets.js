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

function parseRows(rows, { includeAll = false } = {}) {
  return rows
    .map((row, idx) => ({
      rowIndex: idx + 2,
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
    .filter((t) => t.name && (includeAll || !DONE_STATUSES.includes(t.status)));
}

async function getTasks() {
  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);
  console.log(JSON.stringify(parseRows(rows), null, 2));
}

async function getAllTasks() {
  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);
  console.log(JSON.stringify(parseRows(rows, { includeAll: true }), null, 2));
}

/**
 * Find the best matching row for a task hint.
 * Returns { matchRow, matchName } or null if no match.
 */
function findTaskRow(rows, taskHint) {
  // Stage 1: exact substring match
  for (let i = 0; i < rows.length; i++) {
    const name = rows[i][COL_TASK_NAME] || '';
    if (name.includes(taskHint)) {
      return { matchRow: i + 2, matchName: name };
    }
  }

  // Stage 2: word-overlap fuzzy search
  const hintWords = taskHint
    .toLowerCase()
    .split(/[\s　]+/)
    .filter(Boolean);
  let bestScore = 0;
  let bestRow = -1;
  let bestName = '';
  for (let i = 0; i < rows.length; i++) {
    const name = (rows[i][COL_TASK_NAME] || '').toLowerCase();
    let score = 0;
    for (const word of hintWords) {
      if (name.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestRow = i + 2;
      bestName = rows[i][COL_TASK_NAME] || '';
    }
  }

  if (bestScore === 0) return null;
  console.error(
    `あいまい検索でマッチ: "${taskHint}" → "${bestName}" (スコア: ${bestScore})`,
  );
  return { matchRow: bestRow, matchName: bestName };
}

async function updateStatus(taskHint, newStatus) {
  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);

  const match = findTaskRow(rows, taskHint);
  if (!match) {
    console.error(`タスクが見つかりません: "${taskHint}"`);
    process.exit(1);
  }

  const sheets = await getSheets();
  const tz = process.env.TZ || 'Asia/Tokyo';
  const now = new Date().toLocaleString('ja-JP', { timeZone: tz });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!G${match.matchRow}:I${match.matchRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[newStatus, '', now]],
    },
  });

  console.log(`✅ "${match.matchName}" のステータスを "${newStatus}" に更新しました`);
}

async function updateProgress(taskHint, progressNote, newStatus) {
  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);

  const match = findTaskRow(rows, taskHint);
  if (!match) {
    console.error(`タスクが見つかりません: "${taskHint}"`);
    process.exit(1);
  }

  const existingProgress = rows[match.matchRow - 2][COL_PROGRESS] || '';
  const updatedProgress = existingProgress
    ? `${existingProgress}\n${progressNote}`
    : progressNote;

  const sheets = await getSheets();
  const tz = process.env.TZ || 'Asia/Tokyo';
  const now = new Date().toLocaleString('ja-JP', { timeZone: tz });

  if (newStatus) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!G${match.matchRow}:I${match.matchRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[newStatus, updatedProgress, now]],
      },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!H${match.matchRow}:I${match.matchRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[updatedProgress, now]],
      },
    });
  }

  const statusMsg = newStatus ? ` (ステータス: ${newStatus})` : '';
  console.log(`✅ "${match.matchName}" に進捗を追記しました${statusMsg}`);
}

async function batchUpdate(updatesJson) {
  let updates;
  try {
    updates = JSON.parse(updatesJson);
  } catch {
    console.error('エラー: JSON解析に失敗しました');
    process.exit(1);
  }

  if (!Array.isArray(updates) || updates.length === 0) {
    console.error('エラー: 空の更新配列です');
    process.exit(1);
  }

  const spreadsheetId = resolveSpreadsheetId();
  const rows = await getAllRows(spreadsheetId);
  const sheets = await getSheets();
  const tz = process.env.TZ || 'Asia/Tokyo';
  const now = new Date().toLocaleString('ja-JP', { timeZone: tz });

  const batchData = [];
  const results = [];

  for (const upd of updates) {
    const match = findTaskRow(rows, upd.taskHint);
    if (!match) {
      results.push(`⚠️ "${upd.taskHint}" が見つかりませんでした`);
      continue;
    }

    const existingProgress = rows[match.matchRow - 2][COL_PROGRESS] || '';
    const updatedProgress = upd.progress
      ? existingProgress
        ? `${existingProgress}\n${upd.progress}`
        : upd.progress
      : existingProgress;

    if (upd.status) {
      batchData.push({
        range: `${SHEET_NAME}!G${match.matchRow}:I${match.matchRow}`,
        values: [[upd.status, updatedProgress, now]],
      });
    } else if (upd.progress) {
      batchData.push({
        range: `${SHEET_NAME}!H${match.matchRow}:I${match.matchRow}`,
        values: [[updatedProgress, now]],
      });
    }

    // Update local rows cache so subsequent matches see the new progress
    rows[match.matchRow - 2][COL_PROGRESS] = updatedProgress;
    if (upd.status) rows[match.matchRow - 2][COL_STATUS] = upd.status;

    const statusMsg = upd.status ? ` → ${upd.status}` : '';
    results.push(`✅ "${match.matchName}"${statusMsg}`);
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: batchData,
      },
    });
  }

  for (const r of results) console.log(r);
  console.log(`\n合計: ${batchData.length}件 更新`);
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
  } else if (command === 'get-all-tasks') {
    await getAllTasks();
  } else if (command === 'update-status') {
    const [taskHint, newStatus] = args;
    if (!taskHint || !newStatus) {
      console.error('Usage: gsheets.js update-status <task-hint> <status>');
      process.exit(1);
    }
    await updateStatus(taskHint, newStatus);
  } else if (command === 'update-progress') {
    const [taskHint, progressNote, newStatus] = args;
    if (!taskHint || !progressNote) {
      console.error(
        'Usage: gsheets.js update-progress <task-hint> <progress-note> [new-status]',
      );
      process.exit(1);
    }
    await updateProgress(taskHint, progressNote, newStatus || null);
  } else if (command === 'batch-update') {
    const [updatesJson] = args;
    if (!updatesJson) {
      console.error(
        'Usage: gsheets.js batch-update \'[{"taskHint":"...","progress":"...","status":"..."}]\'',
      );
      process.exit(1);
    }
    await batchUpdate(updatesJson);
  } else if (command === 'add-task') {
    const [name, category, priority, dueDate, assignee] = args;
    if (!name) {
      console.error(
        'Usage: gsheets.js add-task <n> [category] [priority] [due-date] [assignee]',
      );
      process.exit(1);
    }
    await addTask(name, category, priority, dueDate, assignee);
  } else {
    console.error(
      '\u30b3\u30de\u30f3\u30c9: get-tasks | get-all-tasks | update-status | update-progress | batch-update | add-task',
    );
    process.exit(1);
  }
} catch (err) {
  console.error('\u30a8\u30e9\u30fc:', err.message);
  process.exit(1);
}
