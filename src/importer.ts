import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { submitProposal } from "./proposals.js";
import { KINDS, VOICES, type Actor, type Layer } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * 問卷回覆的匯入：把其他 AI 對使用者的描述轉成記憶 PR。
 * 這些是第三方轉述，信任度低於使用者親口所述，因此：
 * - 一律不建議進入憲法層（由 Keeper／使用者決定是否晉升）
 * - 推測的信心度設有上限
 * - 回覆全文另存為原始紀錄，張力與提問也保留在那裡
 */

const ItemSchema = z.object({
  claim: z.string().min(1),
  kind: z.enum(KINDS).catch("preference"),
  voice: z.enum(VOICES).catch("inferred"),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  domain: z.string().optional().catch(undefined),
  contexts: z.array(z.string()).optional().catch(undefined),
  evidence: z
    .array(z.object({ quote: z.string().optional(), when: z.string().optional() }))
    .optional()
    .catch(undefined),
  rationale: z.string().optional().catch(undefined),
});

const ReplySchema = z.object({
  respondent: z.string().optional(),
  memory_access: z.string().optional(),
  items: z.array(z.unknown()).default([]),
});

export const INFERRED_MAX_CONFIDENCE = 0.6;

export interface ImportResult {
  raw: string;
  proposals: string[];
  skipped: { index: number; reason: string }[];
}

/** 取出所有 ```yaml 區塊；沒有區塊時把整份當 YAML 解析 */
export function extractYaml(text: string): unknown[] {
  const blocks = [...text.matchAll(/```ya?ml\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const sources = blocks.length ? blocks : [text];
  const out: unknown[] = [];
  for (const s of sources) {
    try {
      out.push(YAML.parse(s));
    } catch {
      // 某些 AI 會在 YAML 區塊內混入說明文字；略過無法解析的區塊
    }
  }
  return out;
}

export async function importQuestionnaire(
  vault: Vault,
  source: string,
  text: string,
): Promise<ImportResult> {
  const slug = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "unknown";
  const date = vault.nowIso().slice(0, 10);
  const session = `questionnaire-${date}`;
  const actor: Actor = { name: slug, role: "agent", clearance: "card" };

  // 原始回覆：append-only，不改寫
  const rawRel = path.join("raw", "imports", `${date}-${slug}.md`);
  await vault.write(`import: raw questionnaire reply from ${slug}`, async () => {
    await fs.mkdir(path.join(vault.root, "raw", "imports"), { recursive: true });
    const target = path.join(vault.root, rawRel);
    await fs.appendFile(target, `<!-- imported ${vault.nowIso()} from ${source} -->\n\n${text.trim()}\n\n`);
    return { result: undefined, paths: [rawRel] };
  });

  const items: unknown[] = [];
  for (const doc of extractYaml(text)) {
    const r = ReplySchema.safeParse(doc);
    if (r.success) items.push(...r.data.items);
  }

  const proposals: string[] = [];
  const skipped: ImportResult["skipped"] = [];
  for (const [index, rawItem] of items.entries()) {
    const r = ItemSchema.safeParse(rawItem);
    if (!r.success) {
      skipped.push({ index, reason: r.error.issues.map((i) => i.message).join("; ") });
      continue;
    }
    const it = r.data;
    const layer: Layer = it.voice === "inferred" || it.kind === "focus" ? "experience" : "preference";
    const confidence =
      it.voice === "inferred" ? Math.min(it.confidence, INFERRED_MAX_CONFIDENCE) : it.confidence;
    const res = await submitProposal(vault, actor, {
      claim: it.claim,
      kind: it.kind,
      voice: it.voice,
      suggested_layer: layer,
      confidence,
      scope: { domain: it.domain, contexts: it.contexts },
      ttl: it.kind === "focus" ? "30d" : null,
      evidence: (it.evidence ?? []).map((e) => ({
        quote: e.quote,
        source: `${slug}/${session}${e.when ? `（${e.when}）` : ""}`,
      })),
      rationale: [`來自 ${source} 的問卷回覆（第三方轉述，原文見 ${rawRel}）。`, it.rationale ?? ""]
        .join(" ")
        .trim(),
      session,
    });
    proposals.push(res.proposal);
  }
  return { raw: rawRel, proposals, skipped };
}
