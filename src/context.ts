import type { ConstitutionDoc, Vault } from "./vault.js";
import { DISCLOSURE_RANK, type Actor, type Layer, type Memory, type MemoryMeta } from "./types.js";

const LAYER_RANK: Record<Layer, number> = { constitution: 0, preference: 1, experience: 2 };
const TTL_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

export function isExpired(m: MemoryMeta, now: Date): boolean {
  if (m.valid_until && Date.parse(m.valid_until) <= now.getTime()) return true;
  if (!m.ttl) return false;
  const n = Number.parseInt(m.ttl, 10);
  const unit = m.ttl.slice(-1) as keyof typeof TTL_MS;
  return Date.parse(m.valid_from) + n * TTL_MS[unit] <= now.getTime();
}

export function isActive(m: MemoryMeta, now: Date): boolean {
  return m.status === "active" && !isExpired(m, now);
}

/** 揭露分級與 agent 範圍：這個 actor 能不能看到這條知識 */
export function canSee(actor: Actor, disclosure: MemoryMeta["disclosure"], agents: string[] = ["*"]): boolean {
  if (DISCLOSURE_RANK[disclosure] > DISCLOSURE_RANK[actor.clearance]) return false;
  if (actor.role !== "agent") return true;
  return agents.includes("*") || agents.includes(actor.name);
}

/** 粗略的 token 估算：CJK 一字約一 token，其餘約四字元一 token */
export function estimateTokens(s: string): number {
  const cjk = (s.match(/[぀-ヿ㐀-鿿豈-﫿]/g) ?? []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** 拉丁字詞 + CJK 二字組，足以應付個人規模的關鍵字比對 */
export function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  for (const w of lower.match(/[a-z0-9_\-]{2,}/g) ?? []) out.add(w);
  for (const run of lower.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function haystack(m: Memory): string {
  const s = m.meta.scope;
  return [m.meta.claim, m.meta.kind, s.domain ?? "", ...s.contexts, m.body].join(" ");
}

function relevance(query: Set<string>, text: string): number {
  if (query.size === 0) return 0;
  const t = tokenize(text);
  let hit = 0;
  for (const q of query) if (t.has(q)) hit++;
  return hit / query.size;
}

const VOICE_LABEL = { stated: "你說的", observed: "觀察", inferred: "推測" } as const;

export function formatLine(m: MemoryMeta): string {
  const tags = [m.layer, m.kind, m.scope.domain, VOICE_LABEL[m.voice], m.confidence.toFixed(1)]
    .filter(Boolean)
    .join("·");
  const ctx = m.scope.contexts.length ? ` [情境：${m.scope.contexts.join("、")}]` : "";
  return `- ${m.id} (${tags}) ${m.claim}${ctx}`;
}

export async function visibleMemories(vault: Vault, actor: Actor): Promise<Memory[]> {
  const now = vault.now();
  return (await vault.listMemories()).filter(
    (m) => isActive(m.meta, now) && canSee(actor, m.meta.disclosure, m.meta.scope.agents),
  );
}

async function visibleConstitution(vault: Vault, actor: Actor): Promise<ConstitutionDoc[]> {
  return (await vault.listConstitution()).filter((d) => canSee(actor, d.disclosure));
}

function rank(items: Memory[], query: Set<string>): Memory[] {
  return items
    .map((m) => ({ m, r: relevance(query, haystack(m)) }))
    .sort(
      (a, b) =>
        LAYER_RANK[a.m.meta.layer] - LAYER_RANK[b.m.meta.layer] ||
        b.r - a.r ||
        b.m.meta.confidence - a.m.meta.confidence,
    )
    .map((x) => x.m);
}

/**
 * get_context：只給索引與摘要。細節由 agent 以 recall 自行調閱。
 * 憲法層全文優先，其餘依層級、相關度、信心度排序，填到預算為止。
 */
export async function getContext(
  vault: Vault,
  actor: Actor,
  task: string,
  budget = 1500,
): Promise<string> {
  const docs = await visibleConstitution(vault, actor);
  const mems = rank(await visibleMemories(vault, actor), tokenize(task));
  const out: string[] = [];
  let used = 0;
  const push = (s: string) => {
    const cost = estimateTokens(s);
    if (used + cost > budget) return false;
    out.push(s);
    used += cost;
    return true;
  };

  push("# 關於使用者（SubstrateMesh）");
  if (docs.length) {
    push("## 憲法層（使用者親筆，優先於一切偏好）");
    for (const d of docs) {
      if (!push(`### ${d.title}\n${d.body}`)) push(`- ${d.file}：${d.title}（內容過長，請以 recall 調閱）`);
    }
  }
  if (mems.length) {
    push("## 知識索引（層級·類型·領域·口吻·信心度）");
    let shown = 0;
    for (const m of mems) {
      if (!push(formatLine(m.meta))) break;
      shown++;
    }
    if (shown < mems.length) {
      out.push(`（另有 ${mems.length - shown} 條未列出；請以 recall(query) 查詢。）`);
    }
  }
  if (!docs.length && !mems.length) {
    out.push("目前尚無可見的使用者知識。若你在互動中學到關於使用者的事，請以 propose_memory 提交。");
  }
  out.push("\n需要細節、證據或原話時，用 recall(id) 或 recall(query)。標示為「推測」的內容不是事實。");
  return out.join("\n");
}

export async function recall(
  vault: Vault,
  actor: Actor,
  opts: { id?: string; query?: string; limit?: number },
): Promise<string> {
  if (opts.id) {
    const m = await vault.readMemory(opts.id);
    if (!m || !canSee(actor, m.meta.disclosure, m.meta.scope.agents)) return `找不到或無權存取：${opts.id}`;
    return renderDetail(m, vault.now());
  }
  const q = tokenize(opts.query ?? "");
  const limit = opts.limit ?? 8;
  const docs = (await visibleConstitution(vault, actor))
    .map((d) => ({ d, r: relevance(q, `${d.title} ${d.body}`) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r);
  const mems = (await visibleMemories(vault, actor))
    .map((m) => ({ m, r: relevance(q, haystack(m)) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r || b.m.meta.confidence - a.m.meta.confidence)
    .slice(0, limit);
  if (!docs.length && !mems.length) return `沒有符合「${opts.query ?? ""}」的知識。`;
  const parts: string[] = [];
  for (const { d } of docs) parts.push(`## 憲法：${d.title}（${d.file}）\n${d.body}`);
  for (const { m } of mems) parts.push(renderDetail(m, vault.now()));
  return parts.join("\n\n---\n\n");
}

function renderDetail(m: Memory, now: Date): string {
  const x = m.meta;
  const lines = [
    `## ${x.id}`,
    `主張：${x.claim}`,
    `層級／類型：${x.layer}／${x.kind}　口吻：${VOICE_LABEL[x.voice]}　信心度：${x.confidence}`,
    `範圍：領域=${x.scope.domain ?? "（不限）"}；情境=${x.scope.contexts.join("、") || "（不限）"}；agent=${x.scope.agents.join("、")}`,
    `狀態：${isActive(x, now) ? "active" : x.status}　生效：${x.valid_from}${x.ttl ? `　TTL：${x.ttl}` : ""}`,
  ];
  if (x.supersedes.length) lines.push(`取代：${x.supersedes.join("、")}`);
  if (m.body) lines.push("", m.body);
  if (x.evidence.length) {
    lines.push("", "證據：");
    for (const e of x.evidence) {
      lines.push(`- ${e.at} ${e.source}${e.quote ? `：「${e.quote}」` : ""}`);
    }
  }
  return lines.join("\n");
}

export const USAGE_GUIDE = `## 畫像使用守則
目標：懂使用者，但不自以為懂。
1. 畫像是先驗，不是判決；傾向不等於規則。
2. 風險高或不確定時，仍然要問。
3. 用畫像去做，不要拿畫像來說——不要以「我知道你喜歡…」證明自己懂。
4. 標示為「推測」的內容不得當成事實陳述。
5. 記錄張力與例外；不要把矛盾抹平成單一標籤。`;

export const SUBMIT_GUIDE = `## 何時提交記憶（propose_memory）
- 使用者糾正你，或明確表達偏好、原則、禁區時。
- 使用者完整接受你的產出而未修改時（可用 record_example 保存範例）。
- 你對使用者形成了新的觀察或推測時——在 rationale 寫下你的觀點與理由。
務必附上使用者原話（evidence.quote），並誠實標示口吻：stated（他說的）／observed（你觀察到的）／inferred（你推測的）。
你只能提案，不能直接改寫知識；Keeper 會審查。`;

/** 連線時經 MCP instructions 注入的精簡核心摘要（僅限名片等級） */
export async function buildInstructions(vault: Vault, actor: Actor, maxTokens = 900): Promise<string> {
  const cardActor: Actor = { ...actor, clearance: "card" };
  const docs = await visibleConstitution(vault, cardActor);
  const mems = rank(
    (await visibleMemories(vault, cardActor)).filter((m) => m.meta.layer !== "experience"),
    new Set(),
  );
  const parts = [
    "SubstrateMesh 是使用者本人擁有的長期記憶基質。開始處理與使用者相關的任務前，先呼叫 get_context(task) 取得關於使用者的索引，需要細節再用 recall。",
    USAGE_GUIDE,
    SUBMIT_GUIDE,
  ];
  let used = parts.reduce((n, p) => n + estimateTokens(p), 0);
  const core: string[] = [];
  for (const d of docs) {
    const s = `### ${d.title}\n${d.body}`;
    if (used + estimateTokens(s) > maxTokens) break;
    core.push(s);
    used += estimateTokens(s);
  }
  for (const m of mems) {
    const s = formatLine(m.meta);
    if (used + estimateTokens(s) > maxTokens) break;
    core.push(s);
    used += estimateTokens(s);
  }
  if (core.length) parts.push(`## 核心摘要（名片）\n${core.join("\n")}`);
  return parts.join("\n\n");
}
