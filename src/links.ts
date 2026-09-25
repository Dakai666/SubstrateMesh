import { cosine } from "./embed.js";
import { score } from "./search.js";
import {
  SYMMETRIC_RELS,
  normalizeTags,
  type Link,
  type LinkRef,
  type LinkRel,
  type Memory,
  type MemoryMeta,
  type ProposalMeta,
} from "./types.js";

/** 從這一端看的關係名稱 */
export const REL_OUT: Record<LinkRel, string> = {
  derived_from: "源自",
  contradicts: "⚠ 張力",
  refines: "細化自",
  example_of: "範例屬於",
  related: "相關",
};
/** 從被指向的一端看的關係名稱 */
export const REL_IN: Record<LinkRel, string> = {
  derived_from: "衍生出",
  contradicts: "⚠ 張力",
  refines: "被細化為",
  example_of: "範例",
  related: "相關",
};

const sameRef = (a: LinkRef, b: LinkRef) => a.to === b.to && a.rel === b.rel;

export interface LinkChanges {
  tags: string[];
  links: Link[];
  remove_tags: string[];
  remove_links: LinkRef[];
}

/** 把標籤與關聯的增刪套用到條目上（不做存在性驗證，由呼叫端負責） */
export function applyLinkChanges(meta: MemoryMeta, c: LinkChanges): void {
  const drop = new Set(normalizeTags(c.remove_tags));
  meta.tags = normalizeTags([...meta.tags, ...c.tags]).filter((t) => !drop.has(t));
  const kept = meta.links.filter(
    (l) => !c.remove_links.some((r) => sameRef(l, r)) && !c.links.some((n) => sameRef(l, n)),
  );
  meta.links = [...kept, ...c.links.filter((l) => l.to !== meta.id)];
}

export interface Neighbor {
  memory: Memory;
  label: string;
  note?: string;
}

/**
 * 一跳關聯：這條指出去的，加上別條指向這條的。
 * `pool` 必須是呼叫者看得到的條目——不在 pool 裡的一律不出現（連 id 都不露）。
 */
export function neighbors(m: Memory, pool: Memory[]): Neighbor[] {
  const byId = new Map(pool.map((x) => [x.meta.id, x]));
  const out: Neighbor[] = [];
  const seen = new Set<string>();
  const add = (memory: Memory | undefined, rel: LinkRel, label: string, note?: string) => {
    if (!memory || memory.meta.id === m.meta.id) return;
    const key = `${memory.meta.id}:${SYMMETRIC_RELS.has(rel) ? rel : label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ memory, label, note });
  };
  for (const l of m.meta.links) add(byId.get(l.to), l.rel, REL_OUT[l.rel], l.note);
  for (const other of pool) {
    for (const l of other.meta.links) {
      if (l.to === m.meta.id) add(other, l.rel, REL_IN[l.rel], l.note);
    }
  }
  // 張力優先：USAGE_GUIDE 第 5 條，矛盾不能被埋在清單後面
  return out.sort((a, b) => Number(b.label.startsWith("⚠")) - Number(a.label.startsWith("⚠")));
}

/** 提案對 target 的標籤／關聯變更，給審查畫面用 */
export function describeLinkChanges(p: ProposalMeta, target: Memory | null): string[] {
  const lines: string[] = [];
  const have = new Set(target?.meta.tags ?? []);
  const addTags = p.tags.filter((t) => !have.has(t));
  const dropTags = p.remove_tags.filter((t) => have.has(t) || !target);
  if (addTags.length) lines.push(`+ 標籤：${addTags.map((t) => `#${t}`).join(" ")}`);
  if (dropTags.length) lines.push(`- 標籤：${dropTags.map((t) => `#${t}`).join(" ")}`);
  for (const l of p.links) {
    const exists = target?.meta.links.some((x) => sameRef(x, l));
    lines.push(`${exists ? "~" : "+"} 關聯：${REL_OUT[l.rel]}（${l.rel}）→ ${l.to}${l.note ? `：${l.note}` : ""}`);
  }
  for (const l of p.remove_links) lines.push(`- 關聯：${REL_OUT[l.rel]}（${l.rel}）→ ${l.to}`);
  return lines;
}

// ---------------- Keeper 整理 ----------------

export interface LinkSuggestion {
  a: Memory;
  b: Memory;
  similarity: number;
  method: "embedding" | "bm25";
}

/** 兩條之間是否已有任何關聯（任一方向、任一種類，含 supersedes） */
function alreadyLinked(a: MemoryMeta, b: MemoryMeta): boolean {
  return (
    a.links.some((l) => l.to === b.id) ||
    b.links.some((l) => l.to === a.id) ||
    a.supersedes.includes(b.id) ||
    b.supersedes.includes(a.id)
  );
}

/**
 * 找出彼此相似、但尚未建立關聯的條目對，交由 Keeper 判斷是重複、矛盾、衍生或只是相關。
 * 有 embedding 時用 cosine（vectors 與 mems 同序），否則以 BM25 互查、除以自身分數正規化。
 */
export function suggestLinks(
  mems: Memory[],
  opts: { vectors: Float32Array[] | null; minSimilarity?: number; limit?: number },
): LinkSuggestion[] {
  const method = opts.vectors ? "embedding" : "bm25";
  const min = opts.minSimilarity ?? (opts.vectors ? 0.72 : 0.15);
  const sim = opts.vectors ? embeddingMatrix(opts.vectors) : bm25Matrix(mems);
  const out: LinkSuggestion[] = [];
  for (let i = 0; i < mems.length; i++) {
    for (let j = i + 1; j < mems.length; j++) {
      const s = sim[i]![j]!;
      if (s < min || alreadyLinked(mems[i]!.meta, mems[j]!.meta)) continue;
      out.push({ a: mems[i]!, b: mems[j]!, similarity: s, method });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, opts.limit ?? 20);
}

function embeddingMatrix(vs: Float32Array[]): number[][] {
  return vs.map((a) => vs.map((b) => cosine(a, b)));
}

function bm25Matrix(mems: Memory[]): number[][] {
  const fields = (m: Memory) => [[m.meta.claim, 1]] as [string, number][];
  const rows = mems.map((m) => {
    const s = score(mems, fields, m.meta.claim);
    const self = s[mems.indexOf(m)] || 1;
    return s.map((x) => x / self);
  });
  // 對稱化：取兩個方向的平均
  return rows.map((r, i) => r.map((x, j) => (x + rows[j]![i]!) / 2));
}

export interface TagUsage {
  tag: string;
  count: number;
}

export interface TagVocabulary {
  tags: TagUsage[];
  /** 可能是同義詞的標籤對（候選，需人工確認） */
  similar: { a: string; b: string; similarity: number }[];
}

export function tagUsage(mems: Memory[]): TagUsage[] {
  const counts = new Map<string, number>();
  for (const m of mems) for (const t of m.meta.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * 同義標籤候選。單詞的 embedding 很吵（實測 life/loom 比 寫作/writing 還像），
 * 所以只當候選清單給 Keeper 判斷，不自動合併。
 */
export function similarTags(
  tags: string[],
  vectors: Float32Array[],
  minSimilarity = 0.68,
): TagVocabulary["similar"] {
  const out: TagVocabulary["similar"] = [];
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const s = cosine(vectors[i]!, vectors[j]!);
      if (s >= minSimilarity) out.push({ a: tags[i]!, b: tags[j]!, similarity: s });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}
