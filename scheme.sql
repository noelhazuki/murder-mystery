-- ===================================
-- マダミス事件簿管理DB (entries方式)
-- ===================================

-- シナリオ本体
CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT
);

-- 全カテゴリ共通の記録テーブル
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,          -- 例: E-001, P-003
  scenario_id TEXT NOT NULL,
  category TEXT NOT NULL,       -- evidence / person / location / reasoning / fact / question
  title TEXT NOT NULL,
  body TEXT,
  parent_id TEXT,                -- 入れ子構造用(例: 書斎→机→引き出し)
  status TEXT,                   -- locationとevidenceのみ使用
                                  --   location: unchecked / checked
                                  --   evidence: unchecked / checked_empty / checked_found
  chapter INTEGER,               -- 時系列の章グループ用
  starred INTEGER DEFAULT 0,     -- お気に入り(0/1)
  updated_at TEXT
);
  name TEXT,
  role TEXT,                -- 被害者/容疑者/参考人
  profile TEXT,
  alibi TEXT,                -- 簡易メモ。詳細はtimelineへ
  suspicion_level TEXT,      -- 高/中/低/なし
  related_files TEXT,        -- JSON配列
  related_clues TEXT,        -- JSON配列
  status TEXT                -- 生存/死亡/退場済み
);

-- 人間関係
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  character_a TEXT,
  character_b TEXT,
  relation_type TEXT,        -- 家族/恋人/同僚/敵対
  description TEXT,
  is_secret TEXT,             -- true/false
  confidence TEXT             -- canon/testimony/theory
);

-- 場所
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  name TEXT,
  description TEXT,
  present_characters TEXT,   -- JSON配列
  found_items TEXT,           -- JSON配列(file_id/clue_id)
  access_condition TEXT
);

-- 時系列（キャラ個人の行動記録・証言ベース）
CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  time_label TEXT,
  character_id TEXT,
  location_id TEXT,
  action TEXT,
  source TEXT,                -- 誰の証言か
  confidence TEXT,             -- canon/testimony/theory
  related_files TEXT
);

-- 出来事（客観的に起きたこと。事件の骨格）
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  time_label TEXT,
  title TEXT,
  description TEXT,
  location_id TEXT,
  related_characters TEXT,
  confidence TEXT
);

-- 調査資料（実物：新聞・手紙・写真など）
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  title TEXT,
  type TEXT,
  content TEXT,
  related_characters TEXT,
  related_clues TEXT,
  status TEXT                 -- open/closed
);

-- 手がかり・伏線
CREATE TABLE IF NOT EXISTS clues (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  note TEXT,
  first_appeared TEXT,        -- session_id
  related_files TEXT,
  status TEXT,                 -- unresolved/resolved
  importance TEXT               -- high/mid/low
);

-- 確定設定（AIが絶対覆してはいけない）
CREATE TABLE IF NOT EXISTS canon (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  content TEXT,
  category TEXT
);

-- 推理・仮説
CREATE TABLE IF NOT EXISTS theories (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  content TEXT,
  related_clues TEXT,
  confidence TEXT               -- 高/中/低
);

-- キャラ固有の秘密
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  character_id TEXT,
  content TEXT,
  revealed TEXT                  -- 未公開/公開済み
);

-- 未解決の質問
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  content TEXT,
  status TEXT,                    -- unresolved/resolved
  related_clues TEXT
);

-- シナリオ固有ルール
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  content TEXT
);
