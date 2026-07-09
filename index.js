// ===================================
// AIマーダーミステリー 事件簿管理API
// ===================================

const TABLES = [
  "scenarios", "sessions", "characters", "relationships",
  "locations", "timeline", "events", "files",
  "clues", "canon", "theories", "secrets",
  "questions", "rules"
];

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

function genId(table) {
  const prefix = table.slice(0, 4).toUpperCase();
  const rand = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${rand}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return json({ ok: true });

    // --- 特別API ---
    if (path === "/api/summary" && method === "GET") {
      return handleSummary(url, env);
    }
    if (path === "/api/export" && method === "GET") {
      return handleExport(url, env);
    }

    // --- 共通CRUD: /api/:table[/:id] ---
    const match = path.match(/^\/api\/([a-z]+)(?:\/([^/]+))?$/);
    if (match) {
      const [, table, id] = match;
      if (!TABLES.includes(table)) {
        return json({ error: `unknown table: ${table}` }, 400);
      }
      try {
        if (method === "GET") return await listRows(env, table, url);
        if (method === "POST") return await createRow(env, table, request);
        if (method === "PUT" && id) return await updateRow(env, table, id, request);
        if (method === "DELETE" && id) return await deleteRow(env, table, id);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // --- 静的ファイル(フロント) ---
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