# Google Sheets スキル

Googleスプレッドシートのタスクデータを読み書きするためのスキルです。

## 利用可能なコマンド

ヘルパースクリプト `/app/gsheets.js` を使用する。実行時は必ず `SPREADSHEET_ID` を設定すること。

スプレッドシートIDの取得:

```bash
SPREADSHEET_ID=$(cat /workspace/group/.spreadsheet_id 2>/dev/null)
if [ -z "$SPREADSHEET_ID" ]; then
  echo "エラー: .spreadsheet_id が見つかりません"
  exit 1
fi
```

### タスク一覧取得

```bash
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js get-tasks
```

JSON配列を返す。完了・中止タスクは除外される。

### タスク一覧取得（全件、完了・中止含む）

```bash
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js get-all-tasks
```

全タスクをJSON配列で返す。既存タスクとの照合に使用する。

JSON配列を返す。各要素:
- `id` — タスクID (例: T0001)
- `name` — タスク名
- `category` — カテゴリ
- `priority` — 優先度 (高/中/低)
- `dueDate` — 期限 (YYYY-MM-DD)
- `assignee` — 担当者
- `status` — ステータス (未着手/進行中/完了/中止)
- `progress` — 進捗メモ（改行区切り時系列）
- `updatedAt` — 最終更新日時

### ステータス更新

```bash
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js update-status "タスク名の一部" "新ステータス"
```

有効なステータス: `未着手` / `進行中` / `完了` / `中止`

タスク名はあいまい検索対応（部分一致→単語スコア順）。

### 進捗の追記（推奨）

```bash
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js update-progress "タスク名の一部" "YYYY/MM/DD：進捗内容" ["新ステータス"]
```

- 進捗メモ（H列）の既存内容に改行で追記する
- ステータスは省略可（省略時はステータス変更なし、進捗のみ追記）
- 更新日時（I列）は自動的に現在時刻に更新される

例:
```bash
# 進捗追記のみ
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js update-progress "ハブ剛性" "2026/03/07：組込完了"

# 進捗追記 + ステータス変更
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js update-progress "ハブ剛性" "2026/03/07：組込完了" "完了"
```

### 一括更新

```bash
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js batch-update '[
  {"taskHint":"ハブ剛性","progress":"2026/03/07：組込完了","status":"完了"},
  {"taskHint":"カメラ","progress":"2026/01/31：カメラ設置完了"}
]'
```

- JSON配列で複数のタスク更新を1回のAPI呼び出しで実行する
- 各要素: `taskHint`（必須）, `progress`（任意）, `status`（任意）
- Sheets batchUpdate APIを使用するため、個別呼び出しより高速

### タスク追加

```bash
SPREADSHEET_ID="$SPREADSHEET_ID" node /app/gsheets.js add-task "タスク名" "カテゴリ" "優先度" "期限" "担当者"
```

優先度: `高` / `中` / `低`
期限: `YYYY-MM-DD` 形式、省略可

## スプレッドシートの列構成

| 列 | 内容 |
|----|------|
| A | タスクID |
| B | タスク名 |
| C | カテゴリ |
| D | 優先度 |
| E | 期限 |
| F | 担当者 |
| G | ステータス |
| H | 進捗メモ |
| I | 更新日時 |

## 認証情報

サービスアカウントJSONは `/workspace/extra/gsheets/credentials.json` に配置する。

ホスト側の設置場所: `~/.config/nanoclaw/gsheets/credentials.json`

## 必要なセットアップ（初回のみ）

1. GCPでサービスアカウントを作成し、Sheets APIを有効化
2. サービスアカウントのJSONキーをダウンロード
3. `~/.config/nanoclaw/gsheets/` ディレクトリを作成して `credentials.json` を配置
4. スプレッドシートをそのサービスアカウントのメールアドレスと共有
5. `~/.config/nanoclaw/mount-allowlist.json` に以下を追加:
   ```json
   { "path": "~/.config/nanoclaw/gsheets", "allowReadWrite": false, "description": "Google Sheets credentials" }
   ```


## チャンネル変更の注意点

**REPORT_CHANNEL** は送信先JIDのみ。`.env` を更新して再起動するだけ。

**TASK_CHANNELS** はDBエントリを作成するため、変更時に古いエントリのクリーンアップが必要。

### 手順

1. `.env` の `TASK_CHANNELS` を新しいチャンネルIDに変更

2. 古い task-bot エントリを削除:

```bash
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE folder='task-bot';"
```

3. 新チャンネルが既に別グループ（discord_main など）として登録済みの場合はそちらも削除:

```bash
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid='dc:<新チャンネルID>';"
```

4. 再起動（`autoRegisterTaskChannels` が新チャンネルを task-bot として登録する）:

```bash
# Linux
systemctl --user restart nanoclaw
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

5. 登録を確認:

```bash
sqlite3 store/messages.db "SELECT jid, folder, container_config FROM registered_groups;"
```

### なぜクリーンアップが必要か

`autoRegisterTaskChannels` は起動時に実行されるが、対象チャンネルが**すでに別グループとして登録されていた場合はスキップ**する（警告ログを出すのみ）。`.env` を修正しても古いDBエントリが残っている限り再登録されない。誤ったチャンネルIDで一度登録すると同じ問題が起きるため、変更前に必ず手順2を実行する。