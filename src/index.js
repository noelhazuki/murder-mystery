// ===================================
// マダミス事件簿管理API (entries方式)
// ===================================

const CATEGORY_PREFIX = {
  evidence: "E",
  person: "P",
  location: "L",
  reasoning: "R",
  fact: "F",
  question: "Q"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return json({ ok: true });

    try {
      // --- シナリオ ---
      if (path === "/api/scenarios" && method === "GET") return await listScenarios(env);
      if (path === "/api/scenarios" && method === "POST") return await createScenario(env, request);

      const scenarioMatch = path.match(/^\/api\/scenarios\/([^/]+)$/);
      if (scenarioMatch && method === "PUT") return await updateScenario(env, scenarioMatch[1], request);
      if (scenarioMatch && method === "DELETE") return await deleteScenario(env, scenarioMatch[1]);

      // --- エントリー(証拠/人物/場所/推理/事実/未解決 共通) ---
      if (path === "/api/entries" && method === "GET") return await listEntries(env, url);
      if (path === "/api/entries" && method === "POST") return await upsertEntries(env, request);

      // --- AI自動分類(バルクテキスト → entries) ---
      if (path === "/api/classify" && method === "POST") return await handleClassify(env, request);

      const entryMatch = path.match(/^\/api\/entries\/([^/]+)$/);
      if (entryMatch && method === "PUT") return await updateEntry(env, entryMatch[1], request);
      if (entryMatch && method === "DELETE") return await deleteEntry(env, entryMatch[1]);

      // --- 特別API ---
      if (path === "/api/summary" && method === "GET") return await handleSummary(url, env);
      if (path === "/api/export" && method === "GET") return await handleExport(url, env);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }

    // --- 静的ファイル(フロント) ---
    return env.ASSETS.fetch(request);
  }
};
// ---------- シナリオ ----------

async function listScenarios(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM scenarios ORDER BY created_at ASC`
  ).all();
  return json({ rows: results });
}

async function createScenario(env, request) {
  const body = await request.json();
  const id = body.id || `SCEN-${crypto.randomUUID().slice(0, 8)}`;
  const title = body.title || "無題";
  await env.DB.prepare(
    `INSERT INTO scenarios (id, title, created_at) VALUES (?, ?, ?)`
  ).bind(id, title, nowIso()).run();
  return json({ ok: true, id, title });
}

async function updateScenario(env, id, request) {
  const body = await request.json();
  if (!body.title) return json({ error: "title required" }, 400);
  await env.DB.prepare(
    `UPDATE scenarios SET title = ? WHERE id = ?`
  ).bind(body.title, id).run();
  return json({ ok: true, id, title: body.title });
}

async function deleteScenario(env, id) {
  // シナリオ本体と、紐づくentriesを両方削除
  await env.DB.prepare(`DELETE FROM entries WHERE scenario_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM scenarios WHERE id = ?`).bind(id).run();
  return json({ ok: true, id });
}

// ---------- エントリー ----------

async function listEntries(env, url) {
  const scenarioId = url.searchParams.get("scenario_id");
  const category = url.searchParams.get("category");
  if (!scenarioId) return json({ error: "scenario_id required" }, 400);

  let sql = `SELECT * FROM entries WHERE scenario_id = ?`;
  const params = [scenarioId];
  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }
  sql += ` ORDER BY updated_at ASC`;

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ rows: results });
}
// AIの自動分類結果をまとめて受け取り、IDが既存なら上書き、新規ならINSERT
async function upsertEntries(env, request) {
  const body = await request.json();
  const entries = Array.isArray(body) ? body : body.entries;
  if (!Array.isArray(entries)) return json({ error: "entries array required" }, 400);
  const results = await upsertEntriesCore(env, entries);
  return json({ results });
}

// upsertEntriesの中身本体(HTTPリクエストに依存しない形。/api/classifyからも呼ぶ)
async function upsertEntriesCore(env, entries) {
  const results = [];
  for (const e of entries) {
    if (!e.scenario_id || !e.category || !e.title) {
      results.push({ ok: false, error: "scenario_id, category, title required", entry: e });
      continue;
    }
    const id = e.id || genEntryId(e.category);
    const existing = await env.DB.prepare(`SELECT id FROM entries WHERE id = ?`).bind(id).first();

    if (existing) {
      await env.DB.prepare(
        `UPDATE entries SET category=?, title=?, body=?, parent_id=?, status=?, chapter=?, deceased=?, updated_at=? WHERE id=?`
      ).bind(
        e.category, e.title, e.body ?? null, e.parent_id ?? null,
        e.status ?? null, e.chapter ?? null, e.deceased ?? 0, nowIso(), id
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO entries (id, scenario_id, category, title, body, parent_id, status, chapter, starred, deceased, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(
        id, e.scenario_id, e.category, e.title, e.body ?? null,
        e.parent_id ?? null, e.status ?? null, e.chapter ?? null, e.deceased ?? 0, nowIso()
      ).run();
    }
    results.push({ ok: true, id });
  }
  return results;
}
async function updateEntry(env, id, request) {
  const body = await request.json();
  const allowed = ["category", "title", "body", "parent_id", "status", "chapter", "starred", "deceased"];
  const keys = Object.keys(body).filter(k => allowed.includes(k));
  if (keys.length === 0) return json({ error: "no valid fields to update" }, 400);

  const setClause = keys.map(k => `${k} = ?`).join(", ") + ", updated_at = ?";
  const sql = `UPDATE entries SET ${setClause} WHERE id = ?`;
  await env.DB.prepare(sql).bind(...keys.map(k => body[k]), nowIso(), id).run();
  return json({ ok: true, id });
}

async function deleteEntry(env, id) {
  await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();
  return json({ ok: true, id });
}

function genEntryId(category) {
  const prefix = CATEGORY_PREFIX[category] || "X";
  const rand = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `${prefix}-${rand}`;
}
// ---------- AI自動分類 ----------

function buildClassifyPrompt(scenarioId, existingEntries) {
  const existingList = existingEntries.length === 0
    ? "(まだ何も登録されていません)"
    : existingEntries.map(e =>
        `- id:${e.id} category:${e.category} title:${e.title} parent_id:${e.parent_id ?? "なし"} chapter:${e.chapter ?? "なし"} status:${e.status ?? "なし"} deceased:${e.deceased ?? 0}`
      ).join("\n");

  const maxChapter = existingEntries.reduce((m, e) => e.chapter && e.chapter > m ? e.chapter : m, 0);

  return `あなたはマーダーミステリーのGM記録係です。プレイヤーから貼り付けられたセッションログのテキストを、以下のルールに従って構造化データ(entries)に分類してください。

【カテゴリ】
- evidence(証拠) / person(人物) / location(場所) / reasoning(推理) / fact(事実) / question(未解決の疑問)

【分類ルール(必ず守ること)】
1. 1つの事項につき1エントリーに分割する。複数の事項を1エントリーにまとめない。
2. 既存entries一覧(下記)に同一の事項があれば、その既存のidをそのまま使う(新規idは発行しない)。新規事項の場合はidを省略する(サーバー側で自動採番される)。
3. parent_idは、既存entries一覧に該当する親が実在する場合のみ設定する。親が存在するかどうか推測で新規に作らない。存在しなければnullにする。
4. statusはcategoryがlocationまたはevidenceの場合のみ設定する。
   - location: "unchecked" または "checked"
   - evidence: "unchecked" または "checked_empty" または "checked_found"
   - それ以外のcategoryではstatusは必ずnullにする。
5. chapterは既存entriesの最大値(現在:${maxChapter})を基準にする。テキスト中に明確な章・場面の転換点がある場合のみ+1し、それ以外は既存の最大値をそのまま使う。
6. bodyにはテキストの要約のみを書く。他のentryとの関連性の推測や示唆(例:「これは〇〇の伏線かもしれない」等)は絶対に書かない。プレイヤーの推理を妨げないこと。
7. カテゴリやparent_idの判断に迷った場合は、より穏当(保守的)な方を選ぶこと。
8. deceasedはcategoryがpersonの場合のみ意味を持つ。その人物が死亡していることが、疑いようのない確定事実としてテキスト中に明記されている場合のみ1にする。「死んだかもしれない」「遺体が発見されたが本人かは不明」など、まだ疑わしい・未確定の段階では0のままにし、その疑惑はcategory:questionのentryとして別途起票すること(person側は書き換えない)。personカテゴリ以外ではdeceasedは常に0にする。

【既存entries一覧(scenario_id: ${scenarioId})】
${existingList}

【出力形式】
以下のJSON形式のみを出力すること。前置き文・説明文・Markdownのコードブロック記号(\`\`\`)は一切つけないこと。

{"entries": [{"id": "(既存の場合のみ)", "scenario_id": "${scenarioId}", "category": "evidence|person|location|reasoning|fact|question", "title": "短いタイトル", "body": "要約本文", "parent_id": "(あれば)", "status": "(evidence/locationのみ)", "chapter": 数値, "deceased": "(personのみ。0または1。死亡が確定事実の場合のみ1)"}]}`;
}

async function handleClassify(env, request) {
  const body = await request.json();
  const scenarioId = body.scenario_id;
  const newText = body.text;
  if (!scenarioId || !newText) return json({ error: "scenario_id and text required" }, 400);

  const { results: existingEntries } = await env.DB.prepare(
    `SELECT id, category, title, parent_id, chapter, status, deceased FROM entries WHERE scenario_id = ?`
  ).bind(scenarioId).all();

  const systemPrompt = buildClassifyPrompt(scenarioId, existingEntries);

  let aiResponse;
  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: newText }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return json({ error: "Claude API error", detail: errText }, 502);
    }
    aiResponse = await apiRes.json();
  } catch (e) {
    return json({ error: "Claude API呼び出しに失敗しました", detail: String(e) }, 502);
  }

  const rawText = (aiResponse.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  let parsed;
  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: "AIの出力をJSONとして解釈できませんでした。もう一度貼り付け直してみてください。", raw: rawText }, 502);
  }

  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) {
    return json({ error: "AIの出力にentries配列が含まれていませんでした。", raw: rawText }, 502);
  }

  // scenario_idはサーバー側で強制的に揃える(AIの書き間違い対策)
  for (const e of entries) e.scenario_id = scenarioId;

  const results = await upsertEntriesCore(env, entries);
  return json({ results, count: results.length });
}

// ---------- AI引き継ぎ要約生成 ----------

const CATEGORY_LABEL = {
  evidence: "証拠",
  person: "人物",
  location: "場所",
  reasoning: "推理",
  fact: "事実",
  question: "未解決"
};

async function handleSummary(url, env) {
  const scenarioId = url.searchParams.get("scenario_id");
  if (!scenarioId) return json({ error: "scenario_id required" }, 400);

  const scenario = await env.DB.prepare(`SELECT * FROM scenarios WHERE id = ?`).bind(scenarioId).first();
  const { results: entries } = await env.DB.prepare(
    `SELECT * FROM entries WHERE scenario_id = ? ORDER BY category, updated_at ASC`
  ).bind(scenarioId).all();

  const lines = [];
  lines.push("【現在の事件状況】");
  lines.push("");
  lines.push(`■シナリオ: ${scenario ? scenario.title : "（不明）"}`);
  lines.push("");

  for (const cat of Object.keys(CATEGORY_LABEL)) {
    const rows = entries.filter(e => e.category === cat);
    lines.push(`■${CATEGORY_LABEL[cat]}`);
    if (rows.length === 0) {
      lines.push("・（なし）");
    } else {
      rows.forEach(r => {
        const statusPart = r.status ? `[${r.status}] ` : "";
        lines.push(`・${statusPart}${r.title}${r.body ? "：" + r.body : ""}`);
      });
    }
    lines.push("");
  }

  lines.push("■AIに守らせるルール");
  lines.push("・確定情報を変更しない");
  lines.push("・推理と事実を混同しない");
  lines.push("・新事実はGMから提示されたものだけ採用する");

  return json({ markdown: lines.join("\n") });
}

// ---------- JSONエクスポート ----------

async function handleExport(url, env) {
  const scenarioId = url.searchParams.get("scenario_id");
  if (!scenarioId) return json({ error: "scenario_id required" }, 400);

  const scenario = await env.DB.prepare(`SELECT * FROM scenarios WHERE id = ?`).bind(scenarioId).first();
  const { results: entries } = await env.DB.prepare(
    `SELECT * FROM entries WHERE scenario_id = ?`
  ).bind(scenarioId).all();

  return json({ scenario, entries });
}