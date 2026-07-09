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
