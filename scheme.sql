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
  deceased INTEGER DEFAULT 0,    -- 死亡確定フラグ(0/1) personカテゴリのみ意味を持つ。確定事実になった時だけ1にする
  updated_at TEXT
);
