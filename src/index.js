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

      // --- エントリー(証拠/人物/場所/推理/事実/未解決 共通) ---
      if (path === "/api/entries" && method === "GET") return await listEntries(env, url);
      if (path === "/api/entries" && method === "POST") return await upsertEntries(env, request);

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
        `UPDATE entries SET category=?, title=?, body=?, parent_id=?, status=?, chapter=?, updated_at=? WHERE id=?`
      ).bind(
        e.category, e.title, e.body ?? null, e.parent_id ?? null,
        e.status ?? null, e.chapter ?? null, nowIso(), id
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO entries (id, scenario_id, category, title, body, parent_id, status, chapter, starred, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).bind(
        id, e.scenario_id, e.category, e.title, e.body ?? null,
        e.parent_id ?? null, e.status ?? null, e.chapter ?? null, nowIso()
      ).run();
    }
    results.push({ ok: true, id });
  }
  return json({ results });
}

async function updateEntry(env, id, request) {
  const body = await request.json();
  const allowed = ["category", "title", "body", "parent_id", "status", "chapter", "starred"];
  const keys = Object.keys(body).filter(k => allowed.includes(k));
  if (keys.length === 0) return json({ error: "no valid fields to update" }, 400);

  const setClause = keys.map(k => `${k} = ?`).join(", ") + ", updated_at = ?";
  const sql = `UPDATE entries SET ${setClause} WHERE id = ?`;
  await env.DB.prepare(sql).bind(...keys.map(k => body[k]), now    // --- 静的ファイル(フロント) ---
    return env.ASSETS.fetch(request);
  }
};

// ---------- 共通CRUD処理 ----------

async function listRows(env, table, url) {
  const scenarioId = url.searchParams.get("scenario_id");
  let stmt;
  if (scenarioId) {
    stmt = env.DB.prepare(`SELECT * FROM ${table} WHERE scenario_id = ?`).bind(scenarioId);
  } else {
    stmt = env.DB.prepare(`SELECT * FROM ${table}`);
  }
  const { results } = await stmt.all();
  return json({ table, rows: results });
}

async function createRow(env, table, request) {
  const body = await request.json();
  if (!body.id) body.id = genId(table);
  const keys = Object.keys(body);
  const placeholders = keys.map(() => "?").join(",");
  const sql = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders})`;
  await env.DB.prepare(sql).bind(...keys.map(k => body[k])).run();
  return json({ ok: true, id: body.id });
}

async function updateRow(env, table, id, request) {
  const body = await request.json();
  const keys = Object.keys(body).filter(k => k !== "id");
  if (keys.length === 0) return json({ error: "no fields to update" }, 400);
  const setClause = keys.map(k => `${k} = ?`).join(", ");
  const sql = `UPDATE ${table} SET ${setClause} WHERE id = ?`;
  await env.DB.prepare(sql).bind(...keys.map(k => body[k]), id).run();
  return json({ ok: true, id });
}

async function deleteRow(env, table, id) {
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  return json({ ok: true, id });
}

// ---------- AI引き継ぎ要約生成 ----------

async function handleSummary(url, env) {
  const scenarioId = url.searchParams.get("scenario_id");
  if (!scenarioId) return json({ error: "scenario_id required" }, 400);

  const q = async (table, extraWhere = "") => {
    const sql = `SELECT * FROM ${table} WHERE scenario_id = ? ${extraWhere}`;
    const { results } = await env.DB.prepare(sql).bind(scenarioId).all();
    return results;
  };

  const scenario = (await q("scenarios"))[0] || {};
  const characters = await q("characters");
  const canonRows = await q("canon");
  const theoriesAll = await q("theories");
  const files = await q("files");
  const clues = await q("clues", "AND status = 'unresolved'");
  const questions = await q("questions", "AND status = 'unresolved'");
  const sessions = await q("sessions");
  const rules = await q("rules");

  const suspects = characters.filter(c => c.role && c.role.includes("容疑")).map(c => c.name);
  const important = characters.filter(c => c.role && !c.role.includes("容疑")).map(c => c.name);
  const highTheories = theoriesAll.filter(t => t.confidence === "高" || t.confidence === "high");
  const lowTheories = theoriesAll.filter(t => t.confidence !== "高" && t.confidence !== "high");

  const lastSession = sessions.sort((a, b) => (b.played_at || "").localeCompare(a.played_at || ""))[0];

  const lines = [];
  lines.push("【現在の事件状況】");
  lines.push("");
  lines.push("■シナリオ");
  lines.push(`タイトル：${scenario.title || ""}`);
  lines.push(`現在フェーズ：${scenario.current_phase || ""}`);
  lines.push("");
  lines.push("■事件概要");
  lines.push(`被害者：${scenario.victim || ""}`);
  lines.push(`事件内容：${scenario.incident_summary || ""}`);
  lines.push("");
  lines.push("■登場人物");
  lines.push(`容疑者：${suspects.join("、") || "（なし）"}`);
  lines.push(`重要人物：${important.join("、") || "（なし）"}`);
  lines.push("");
  lines.push("■確定情報（Canon）");
  canonRows.forEach(c => lines.push(`・${c.content}`));
  if (canonRows.length === 0) lines.push("・（なし）");
  lines.push("");
  lines.push("■未確定情報");
  lowTheories.forEach(t => lines.push(`・${t.content}`));
  if (lowTheories.length === 0) lines.push("・（なし）");
  lines.push("");
  lines.push("■証拠・調査資料");
  files.forEach(f => lines.push(`・${f.title}：${f.content}`));
  if (files.length === 0) lines.push("・（なし）");
  lines.push("");
  lines.push("■未回収の伏線");
  clues.forEach(c => lines.push(`・${c.note}（重要度：${c.importance || "-"}）`));
  if (clues.length === 0) lines.push("・（なし）");
  lines.push("");
  lines.push("■矛盾点・違和感");
  lines.push("・（手動確認：timeline/relationshipsのconfidence=testimony同士を比較）");
  lines.push("");
  lines.push("■現在の有力説（Theory）");
  highTheories.forEach(t => lines.push(`・${t.content}`));
  if (highTheories.length === 0) lines.push("・（なし）");
  lines.push("");
  lines.push("■未解決の質問");
  questions.forEach(q2 => lines.push(`・${q2.content}`));
  if (questions.length === 0) lines.push("・（なし）");
  lines.push("");
  lines.push("■次に調査すべきこと");
  lines.push("・（未解決の質問・伏線から手動選定）");
  lines.push("");
  lines.push("■AIに守らせるルール");
  rules.forEach(r => lines.push(`・${r.content}`));
  lines.push("・確定情報を変更しない");
  lines.push("・推理と事実を混同しない");
  lines.push("・新事実はGMから提示されたものだけ採用する");
  lines.push("");
  lines.push("【前回からの更新】");
  if (lastSession) {
    lines.push(`・${lastSession.discovered || ""}`);
    if (lastSession.new_testimony) lines.push(`・${lastSession.new_testimony}`);
  } else {
    lines.push("・（セッション記録なし）");
  }

  return json({ markdown: lines.join("\n") });
}

// ---------- JSONエクスポート ----------

async function handleExport(url, env) {
  const scenarioId = url.searchParams.get("scenario_id");
  if (!scenarioId) return json({ error: "scenario_id required" }, 400);

  const out = {};
  for (const table of TABLES) {
    const whereClause = table === "scenarios" ? "WHERE id = ?" : "WHERE scenario_id = ?";
    const sql = `SELECT * FROM ${table} ${whereClause}`;
    const { results } = await env.DB.prepare(sql).bind(scenarioId).all();
    out[table] = results;
  }
  return json(out);
}
