import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildInstructions, getContext, recall } from "./context.js";
import { linkChangeSection, linkSuggestionReport, tagReport } from "./curate.js";
import { SUGGEST_MIN_BM25, SUGGEST_MIN_EMBEDDING } from "./links.js";
import {
  PolicyError,
  commentProposal,
  expireMemories,
  mergeProposal,
  submitProposal,
  submitRelink,
  transitionProposal,
} from "./proposals.js";
import { loadTokens, verifyGrant } from "./tokens.js";
import { DISCLOSURES, KINDS, LAYERS, LINK_RELS, PROPOSAL_STATUSES, VOICES, type Actor } from "./types.js";
import type { Vault } from "./vault.js";

export const SERVER_NAME = "substrate";
export const VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    const msg = err instanceof PolicyError ? `拒絕：${err.message}` : `錯誤：${(err as Error).message}`;
    return { ...text(msg), isError: true };
  }
}

const scopeShape = z
  .object({
    domain: z.string().optional().describe("領域，例如 coding、writing、security、life"),
    contexts: z.array(z.string()).optional().describe("適用情境，例如 [code-review]"),
    agents: z
      .array(z.string())
      .optional()
      .describe("只對哪些 agent 成立；省略代表全部。使用者對不同 agent 可以有不同期待"),
  })
  .optional();

const evidenceShape = z
  .array(
    z.object({
      quote: z.string().optional().describe("使用者原話，盡量逐字"),
      source: z.string().optional().describe("來源，預設為 <agent>/<session>"),
      at: z.string().optional().describe("ISO 時間，預設為現在"),
    }),
  )
  .optional();

const memId = z.string().regex(/^mem_[0-9A-Z]{26}$/);

const tagsShape = z
  .array(z.string())
  .optional()
  .describe("自由標籤，例如 [writing, blog]；會正規化為小寫。先用 list_tags 看既有詞彙，避免同義詞各寫一個");

const linksShape = z
  .array(
    z.object({
      to: memId.describe("關聯到的 mem_... id"),
      rel: z
        .enum(LINK_RELS)
        .describe("derived_from 源自／contradicts 互相矛盾／refines 細化／example_of 是其範例／related 相關"),
      note: z.string().optional().describe("一句話說明關聯"),
    }),
  )
  .optional();

/**
 * 依呼叫者身分建立 MCP server。身分由 transport 層（token 或啟動參數）決定，
 * agent 無法自報為 Keeper。
 */
export interface ServerOptions {
  /** token 設定檔；審查時段授權（grant）存放於此。未提供時 merge_proposal 不接受 grant */
  tokensFile?: string;
}

export async function buildServer(
  vault: Vault,
  actor: Actor,
  session?: string,
  opts: ServerOptions = {},
): Promise<McpServer> {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: await buildInstructions(vault, actor) },
  );

  server.registerTool(
    "get_context",
    {
      title: "取得關於使用者的上下文",
      description:
        "依任務描述回傳關於使用者的精簡索引：憲法層（原則、紅線、自主邊界）與相關知識的一行摘要。開始與使用者相關的工作前先呼叫；需要細節時再用 recall。",
      inputSchema: {
        task: z.string().describe("你正要做的事，用來挑選相關知識"),
        budget: z.number().int().min(200).max(8000).optional().describe("token 預算，預設 1500"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ task, budget }) =>
      guard(async () => {
        await vault.logAccess({ type: "get_context", actor: actor.name, session, task });
        return getContext(vault, actor, task, budget);
      }),
  );

  server.registerTool(
    "recall",
    {
      title: "調閱使用者知識細節",
      description:
        "以 id 取得單條知識的完整內容與證據原話，或以關鍵字查詢相關知識。知識多以繁體中文記錄；查詢時用中文關鍵字，可一次給多個同義詞（空白分隔）以提高命中率。",
      inputSchema: {
        id: z.string().optional().describe("mem_... 條目 id"),
        query: z.string().optional().describe("查詢關鍵字，例如「咖啡 飲料 早餐」"),
        tags: z.array(z.string()).optional().describe("只看同時帶有這些標籤的條目；可單獨使用"),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, query, tags, limit }) =>
      guard(async () => {
        if (!id && !query && !tags?.length) throw new PolicyError("請提供 id、query 或 tags。");
        await vault.logAccess({ type: "recall", actor: actor.name, session, id, query, tags });
        return recall(vault, actor, { id, query, tags, limit });
      }),
  );

  server.registerTool(
    "list_tags",
    {
      title: "列出標籤詞彙",
      description: "列出你看得到的知識所使用的標籤與次數。提交 tags 前先看一下，沿用既有詞彙。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(() => tagReport(vault, actor, actor.role !== "agent")),
  );

  server.registerTool(
    "propose_memory",
    {
      title: "提交記憶 PR",
      description:
        "提交一筆關於使用者的知識提案，由 Keeper 審查後才會生效。時機：使用者糾正你、明確表達偏好／原則／禁區，或你形成了新的觀察。務必附原話，並誠實標示口吻。你的觀點與推論寫在 rationale。",
      inputSchema: {
        claim: z.string().min(1).describe("一句話的主張，例如「code review 時先給結論再展開」"),
        kind: z.enum(KINDS).describe("preference 偏好／fact 事實／principle 原則／lesson 教訓／example 範例／focus 當前焦點／calibration 默契校準"),
        voice: z.enum(VOICES).describe("stated 使用者親口說／observed 你觀察到／inferred 你推測"),
        suggested_layer: z.enum(LAYERS).describe("建議層級；inferred 不可為 constitution"),
        confidence: z.number().min(0).max(1),
        scope: scopeShape,
        disclosure: z.enum(DISCLOSURES).optional().describe("card 名片／profile 畫像（預設）／private 私密"),
        ttl: z.string().regex(/^\d+[hdw]$/).optional().describe("時效，例如 30d；當前焦點類建議設定"),
        evidence: evidenceShape,
        rationale: z.string().optional().describe("你的觀點與理由"),
        action: z.enum(["create", "update", "supersede", "archive"]).optional().describe("預設 create"),
        target: z.string().optional().describe("update／supersede／archive 時的 mem_... id"),
        tags: tagsShape,
        links: linksShape.describe("與其他知識的關聯，例如這條偏好源自哪次教訓、與哪條互相矛盾"),
      },
    },
    (args) =>
      guard(async () => {
        const r = await submitProposal(vault, actor, { ...args, session });
        return [`已提交 ${r.proposal}，等待 Keeper 審查。`, ...r.notes].join("\n");
      }),
  );

  server.registerTool(
    "record_example",
    {
      title: "記錄優秀範例",
      description: "使用者完整接受、未修改你的產出時，保存為範例（few-shot 的材料）。",
      inputSchema: {
        title: z.string().describe("範例是什麼，例如「技術決策備忘錄」"),
        content: z.string().describe("產出全文"),
        why: z.string().optional().describe("你認為使用者接受它的原因"),
        scope: scopeShape,
        evidence: evidenceShape,
      },
    },
    ({ title, content, why, scope, evidence }) =>
      guard(async () => {
        const r = await submitProposal(vault, actor, {
          claim: `範例：${title}`,
          kind: "example",
          voice: "observed",
          suggested_layer: "experience",
          confidence: 0.6,
          scope,
          evidence,
          rationale: why,
          body: content,
          session,
        });
        return [`已提交範例 ${r.proposal}。`, ...r.notes].join("\n");
      }),
  );

  server.registerTool(
    "propose_links",
    {
      title: "提出標籤或關聯調整",
      description:
        "只調整既有知識的標籤或關聯，不改主張，同樣經 Keeper 審查。例如：發現兩條知識互相矛盾（contradicts）、一條偏好源自某次教訓（derived_from）。矛盾不必消解，記下張力即可。",
      inputSchema: {
        target: memId.describe("要調整的 mem_... id"),
        tags: tagsShape,
        links: linksShape,
        remove_tags: z.array(z.string()).optional(),
        remove_links: z.array(z.object({ to: memId, rel: z.enum(LINK_RELS) })).optional(),
        rationale: z.string().optional().describe("你的觀點與理由"),
      },
    },
    (args) =>
      guard(async () => {
        const r = await submitRelink(vault, actor, { ...args, session });
        return [`已提交 ${r.proposal}，等待 Keeper 審查。`, ...r.notes].join("\n");
      }),
  );

  if (actor.role !== "agent") registerReviewTools(server, vault, actor, opts);
  return server;
}

function registerReviewTools(server: McpServer, vault: Vault, actor: Actor, opts: ServerOptions) {
  server.registerTool(
    "list_proposals",
    {
      title: "列出記憶 PR",
      description: "依狀態列出提案（預設 pending）。",
      inputSchema: { status: z.enum(PROPOSAL_STATUSES).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ status }) =>
      guard(async () => {
        const want = status ?? "pending";
        const ps = (await vault.listProposals()).filter((p) => p.meta.status === want);
        if (!ps.length) return `沒有 ${want} 的提案。`;
        return ps
          .map((p) => {
            const m = p.meta;
            const quotes = m.evidence.filter((e) => e.quote).length;
            return `- ${m.id} [${m.action}${m.target ? `→${m.target}` : ""}] (${m.suggested_layer}·${m.kind}·${m.voice}·${m.confidence}) by ${m.proposer}，證據 ${m.evidence.length}（原話 ${quotes}）：${m.claim}`;
          })
          .join("\n");
      }),
  );

  server.registerTool(
    "show_proposal",
    {
      title: "查看記憶 PR",
      description: "顯示提案全文（含證據、理由與討論串），以及 target 條目的現況。",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guard(async () => {
        const p = await vault.readProposal(id);
        if (!p) throw new PolicyError(`找不到提案：${id}`);
        const out = [JSON.stringify(p.meta, null, 2)];
        const changes = await linkChangeSection(vault, p);
        if (changes) out.push(changes);
        if (p.body) out.push(`## 內容\n${p.body}`);
        if (p.thread.length) {
          out.push(
            "## 討論串\n" + p.thread.map((e) => `- ${e.at} ${e.author}(${e.role})：${e.text}`).join("\n"),
          );
        }
        if (p.meta.target) out.push(`## target 現況\n${await recall(vault, actor, { id: p.meta.target })}`);
        return out.join("\n\n");
      }),
  );

  server.registerTool(
    "merge_proposal",
    {
      title: "合併記憶 PR",
      description:
        "合併提案並寫入知識。不能合併自己提交的提案，除非使用者已在對話中同意、並給了審查時段授權（grant）；觸及憲法層的提案只能由使用者合併（Keeper 請改用 escalate_proposal）。可用 overrides 調整層級、主張、信心度等。",
      inputSchema: {
        id: z.string(),
        grant: z
          .string()
          .optional()
          .describe(
            "使用者給的審查時段授權（sg_…）。只在合併你自己提交、且使用者已在對話中逐條討論並同意的提案時附上",
          ),
        note: z.string().optional().describe("裁決理由"),
        overrides: z
          .object({
            layer: z.enum(LAYERS).optional(),
            kind: z.enum(KINDS).optional(),
            claim: z.string().optional(),
            confidence: z.number().min(0).max(1).optional(),
            scope: scopeShape,
            disclosure: z.enum(DISCLOSURES).optional(),
            ttl: z.string().regex(/^\d+[hdw]$/).nullable().optional(),
            tags: z
              .array(z.string())
              .optional()
              .describe("合併後條目的最終標籤（完整取代，含 target 原有的；整理詞彙用）"),
          })
          .optional(),
      },
    },
    ({ id, note, overrides, grant }) =>
      guard(async () => {
        let verified: { id: string } | undefined;
        if (grant) {
          if (!opts.tokensFile) throw new PolicyError("這個 server 沒有設定 token 檔，無法驗證審查時段授權。");
          const g = verifyGrant(await loadTokens(opts.tokensFile), grant, new Date(vault.nowIso()));
          if (!g) throw new PolicyError("審查時段授權無效或已過期；請使用者重新執行 substrate keeper grant。");
          verified = { id: g.id };
        }
        const r = await mergeProposal(vault, actor, id, note, overrides ?? {}, verified);
        return [`已合併 ${id} → ${r.memory}`, ...r.warnings.map((w) => `注意：${w}`)].join("\n");
      }),
  );

  server.registerTool(
    "suggest_links",
    {
      title: "候選關聯",
      description:
        "找出彼此相似、但尚未建立關聯的知識對（有 embedding 時用語意相似度，否則 BM25），逐組判斷是重複、矛盾、衍生或相關。確認後以提案落地；Keeper 自己提的提案需由使用者合併。",
      inputSchema: {
        min_similarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(`相似度下限；embedding 預設 ${SUGGEST_MIN_EMBEDDING}、BM25 預設 ${SUGGEST_MIN_BM25}`),
        limit: z.number().int().min(1).max(100).optional().describe("預設 20"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ min_similarity, limit }) => guard(() => linkSuggestionReport(vault, { minSimilarity: min_similarity, limit })),
  );

  for (const [name, to, title, arg] of [
    ["reject_proposal", "rejected", "拒絕記憶 PR（保留紀錄，避免重複提交）", "reason"],
    ["defer_proposal", "deferred", "延後記憶 PR（等待更多獨立證據）", "reason"],
    ["escalate_proposal", "escalated", "上呈使用者裁決（衝突或觸及憲法層）", "question"],
  ] as const) {
    server.registerTool(
      name,
      { title, description: title, inputSchema: { id: z.string(), [arg]: z.string().min(1) } },
      (args: Record<string, string>) =>
        guard(async () => {
          await transitionProposal(vault, actor, args.id, to, args[arg]);
          return `${args.id} → ${to}`;
        }),
    );
  }

  server.registerTool(
    "comment_proposal",
    {
      title: "在記憶 PR 留言",
      description: "在提案討論串追加一則留言。",
      inputSchema: { id: z.string(), text: z.string().min(1) },
    },
    ({ id, text: t }) =>
      guard(async () => {
        await commentProposal(vault, actor, id, t);
        return `已留言於 ${id}`;
      }),
  );

  server.registerTool(
    "expire_memories",
    {
      title: "代謝：封存到期知識",
      description: "把 TTL 或 valid_until 已到期的知識標記為 archived（不刪除）。",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const ids = await expireMemories(vault, actor);
        return ids.length ? `已封存：${ids.join("、")}` : "沒有到期的知識。";
      }),
  );
}
