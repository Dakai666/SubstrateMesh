import { formatLine, semanticCorpus, visibleMemories } from "./context.js";
import { describeLinkChanges, similarTags, suggestLinks, tagUsage } from "./links.js";
import type { Actor, Proposal } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * Keeper 整理用的報告：相似條目的候選關聯、標籤詞彙表。
 * 只列候選，不直接改寫；確認後由提案（propose_links／relink）落地。
 */
export async function linkSuggestionReport(
  vault: Vault,
  opts: { minSimilarity?: number; limit?: number } = {},
): Promise<string> {
  const corpus = await semanticCorpus(vault);
  const all = (await vault.semantic?.vectors(corpus.texts)) ?? null;
  // 語料前段是憲法文件，後段才是條目
  const vectors = all ? all.slice(all.length - corpus.memories.length) : null;
  const list = suggestLinks(corpus.memories, { vectors, ...opts });
  const how = vectors ? "embedding cosine" : "BM25（未啟用或連不上 embedding）";
  if (!list.length) return `沒有找到尚未建立關聯的相似條目（${how}）。`;
  const out = [
    `# 候選關聯（${how}，${list.length} 組）`,
    "請逐組判斷：重複 → supersede／archive；矛盾 → contradicts；衍生 → derived_from；細化 → refines；範例 → example_of；只是相關 → related；無關則略過。",
  ];
  for (const s of list) {
    out.push("", `## ${s.similarity.toFixed(3)}`, formatLine(s.a.meta), formatLine(s.b.meta));
  }
  return out.join("\n");
}

export async function tagReport(vault: Vault, actor: Actor, withSimilar: boolean): Promise<string> {
  const usage = tagUsage(await visibleMemories(vault, actor));
  if (!usage.length) return "目前還沒有任何標籤。";
  const out = ["# 標籤詞彙表", usage.map((u) => `#${u.tag}（${u.count}）`).join("　")];
  if (withSimilar && vault.semantic && usage.length > 1) {
    const tags = usage.map((u) => u.tag);
    const vecs = await vault.semantic.adhoc(tags);
    const similar = vecs ? similarTags(tags, vecs) : [];
    if (similar.length) {
      out.push("", "## 可能同義（候選，需人工確認）");
      for (const s of similar) out.push(`- #${s.a} ／ #${s.b}（${s.similarity.toFixed(3)}）`);
    }
  }
  return out.join("\n");
}

/** 審查畫面的「標籤／關聯變更」區塊；沒有變更時回傳空字串 */
export async function linkChangeSection(vault: Vault, p: Proposal): Promise<string> {
  const target = p.meta.target ? await vault.readMemory(p.meta.target) : null;
  const lines = describeLinkChanges(p.meta, target);
  return lines.length ? `## 標籤／關聯變更\n${lines.join("\n")}` : "";
}
