import { describe, expect, it } from "vitest";
import { getContext, recall } from "../src/context.js";
import { linkSuggestionReport, tagReport } from "../src/curate.js";
import { similarTags, suggestLinks, tagUsage } from "../src/links.js";
import {
  PolicyError,
  mergeProposal,
  submitProposal,
  submitRelink,
  type SubmitInput,
} from "../src/proposals.js";
import { MemorySchema } from "../src/types.js";
import type { Vault } from "../src/vault.js";
import { claude, keeper, quote, tempVault, user } from "./helpers.js";

async function seed(v: Vault, input: Partial<SubmitInput> & { claim: string }) {
  const { proposal } = await submitProposal(v, input.disclosure === "private" ? keeper : claude, {
    kind: "preference",
    voice: "stated",
    suggested_layer: "preference",
    confidence: 0.7,
    evidence: quote(input.claim),
    ...input,
  });
  // Keeper 不能合併自己的提案，私密條目由使用者合併
  return (await mergeProposal(v, input.disclosure === "private" ? user : keeper, proposal)).memory;
}

async function relink(v: Vault, input: Parameters<typeof submitRelink>[2]) {
  const { proposal } = await submitRelink(v, claude, input);
  return mergeProposal(v, keeper, proposal);
}

describe("schema", () => {
  it("標籤正規化為小寫並去重；舊資料不需遷移", () => {
    const base = {
      id: "mem_01M3AA27PQZHFPMN3GGK1QXKZA",
      layer: "preference",
      kind: "preference",
      voice: "stated",
      claim: "x",
      confidence: 0.5,
      valid_from: "2026-01-01",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };
    const old = MemorySchema.parse(base);
    expect(old.tags).toEqual([]);
    expect(old.links).toEqual([]);
    expect(MemorySchema.parse({ ...base, tags: ["Writing", " writing ", "#Blog Post", ""] }).tags).toEqual([
      "writing",
      "blog-post",
    ]);
  });
});

describe("提案與合併", () => {
  it("create 帶標籤與關聯；兩端的 recall 都看得到，張力特別標示", async () => {
    const v = await tempVault();
    const a = await seed(v, { claim: "文章要直接", tags: ["Writing"] });
    const b = await seed(v, {
      claim: "對長輩寫信要委婉",
      tags: ["writing"],
      links: [{ to: a, rel: "contradicts", note: "對象不同" }],
    });
    const mb = await v.readMemory(b);
    expect(mb?.meta.tags).toEqual(["writing"]);
    expect(mb?.meta.links).toEqual([{ to: a, rel: "contradicts", note: "對象不同" }]);
    // 雙向：只存一端，兩端都顯示
    expect((await v.readMemory(a))?.meta.links).toEqual([]);
    const fromA = await recall(v, claude, { id: a });
    expect(fromA).toMatch(new RegExp(`〔⚠ 張力〕${b}.*對長輩寫信要委婉.*（對象不同）`));
    expect(await recall(v, claude, { id: b })).toContain(`〔⚠ 張力〕${a}`);
  });

  it("有方向的關係在兩端顯示不同名稱", async () => {
    const v = await tempVault();
    const lesson = await seed(v, { claim: "曾因沒備份而遺失資料", kind: "lesson" });
    const pref = await seed(v, { claim: "改設定前先備份", links: [{ to: lesson, rel: "derived_from" }] });
    expect(await recall(v, claude, { id: pref })).toContain(`〔源自〕${lesson}`);
    expect(await recall(v, claude, { id: lesson })).toContain(`〔衍生出〕${pref}`);
  });

  it("提交時關聯目標必須存在且看得到，也不能指向自己", async () => {
    const v = await tempVault();
    const a = await seed(v, { claim: "條目 A" });
    const ghost = "mem_01M3AA27PQZHFPMN3GGK1QXKZZ";
    await expect(seed(v, { claim: "條目 B", links: [{ to: ghost, rel: "related" }] })).rejects.toThrow(
      /找不到或無權存取關聯目標/,
    );
    await expect(relink(v, { target: a, links: [{ to: a, rel: "related" }] })).rejects.toThrow(/自己/);
  });

  it("指向已被取代的條目時給警告", async () => {
    const v = await tempVault();
    const old = await seed(v, { claim: "舊的說法" });
    const target = await seed(v, { claim: "另一條" });
    const { proposal } = await submitProposal(v, claude, {
      claim: "新的說法",
      kind: "preference",
      voice: "stated",
      suggested_layer: "preference",
      confidence: 0.7,
      action: "supersede",
      target: old,
    });
    await mergeProposal(v, keeper, proposal);
    const { proposal: p2 } = await submitProposal(v, keeper, {
      claim: "關聯調整",
      kind: "preference",
      voice: "stated",
      suggested_layer: "preference",
      confidence: 0.7,
      action: "relink",
      target,
      links: [{ to: old, rel: "related" }],
    });
    const r = await mergeProposal(v, user, p2);
    expect(r.warnings.join()).toContain("superseded");
  });

  it("relink 只調整標籤與關聯，不改主張；需要至少一項變更", async () => {
    const v = await tempVault();
    const a = await seed(v, { claim: "code review 先給結論", tags: ["coding", "old"] });
    const b = await seed(v, { claim: "報告先講結論" });
    await relink(v, { target: a, tags: ["Review"], remove_tags: ["old"], links: [{ to: b, rel: "related" }] });
    const m = (await v.readMemory(a))!.meta;
    expect(m.claim).toBe("code review 先給結論");
    expect(m.tags).toEqual(["coding", "review"]);
    expect(m.links).toEqual([{ to: b, rel: "related" }]);
    await expect(submitRelink(v, claude, { target: a })).rejects.toThrow(PolicyError);
  });

  it("移除雙向關聯時，即使存在另一端也會移除", async () => {
    const v = await tempVault();
    const a = await seed(v, { claim: "條目 A" });
    const b = await seed(v, { claim: "條目 B", links: [{ to: a, rel: "contradicts" }] });
    await relink(v, { target: a, remove_links: [{ to: b, rel: "contradicts" }] });
    expect((await v.readMemory(b))!.meta.links).toEqual([]);
    expect(await recall(v, claude, { id: a })).not.toContain("張力");
  });

  it("雙向關係已存於另一端時略過重複", async () => {
    const v = await tempVault();
    const a = await seed(v, { claim: "條目 A" });
    const b = await seed(v, { claim: "條目 B", links: [{ to: a, rel: "related" }] });
    const r = await relink(v, { target: a, links: [{ to: b, rel: "related" }] });
    expect(r.warnings.join()).toContain("略過重複");
    expect((await v.readMemory(a))!.meta.links).toEqual([]);
  });

  it("supersede 承接舊版的標籤與關聯", async () => {
    const v = await tempVault();
    const other = await seed(v, { claim: "相關條目" });
    const old = await seed(v, { claim: "舊版", tags: ["life"], links: [{ to: other, rel: "related" }] });
    const { proposal } = await submitProposal(v, claude, {
      claim: "新版",
      kind: "preference",
      voice: "stated",
      suggested_layer: "preference",
      confidence: 0.7,
      action: "supersede",
      target: old,
      tags: ["daily"],
    });
    const { memory } = await mergeProposal(v, keeper, proposal);
    const m = (await v.readMemory(memory))!.meta;
    expect(m.tags).toEqual(["life", "daily"]);
    expect(m.links).toEqual([{ to: other, rel: "related" }]);
  });

  it("相同主張的佐證會併入標籤", async () => {
    const v = await tempVault();
    const base = { claim: "偏好深色主題", kind: "preference", voice: "stated", suggested_layer: "preference", confidence: 0.6 } as const;
    const first = await submitProposal(v, claude, { ...base, tags: ["ui"] });
    await submitProposal(v, { ...claude, name: "opencode" }, { ...base, tags: ["theme"] });
    expect((await v.readProposal(first.proposal))!.meta.tags).toEqual(["ui", "theme"]);
  });
});

describe("揭露權限：看不到的卡片不會經由關聯洩漏", () => {
  it("雙向、有向、指入、指出都不露出 id", async () => {
    const v = await tempVault();
    const pub = await seed(v, { claim: "公開條目" });
    const secret = await seed(v, {
      claim: "私密條目",
      disclosure: "private",
      links: [{ to: pub, rel: "contradicts" }],
    });
    const hermesOnly = await seed(v, { claim: "只給 hermes", scope: { agents: ["hermes"] } });
    const { proposal } = await submitRelink(v, keeper, {
      target: pub,
      links: [
        { to: secret, rel: "derived_from" },
        { to: hermesOnly, rel: "related" },
      ],
    });
    await mergeProposal(v, user, proposal);

    for (const out of [
      await recall(v, claude, { id: pub }),
      await recall(v, claude, { query: "公開條目" }),
      await getContext(v, claude, "公開條目"),
    ]) {
      expect(out).toContain(pub);
      expect(out).not.toContain(secret);
      expect(out).not.toContain(hermesOnly);
      expect(out).not.toContain("張力");
    }
    // 看得到的人照常顯示
    expect(await recall(v, keeper, { id: pub })).toContain(secret);
    expect(await recall(v, { ...claude, name: "hermes" }, { id: pub })).toContain(hermesOnly);
  });

  it("看不到的目標與不存在的目標，錯誤訊息一致", async () => {
    const v = await tempVault();
    const pub = await seed(v, { claim: "公開條目" });
    const secret = await seed(v, { claim: "私密條目", disclosure: "private" });
    const ghost = "mem_01M3AA27PQZHFPMN3GGK1QXKZZ";
    const msg = async (fn: () => Promise<unknown>) => (await fn().catch((e: Error) => e.message)) as string;
    const a = await msg(() => submitRelink(v, claude, { target: pub, links: [{ to: secret, rel: "related" }] }));
    const b = await msg(() => submitRelink(v, claude, { target: pub, links: [{ to: ghost, rel: "related" }] }));
    expect(a.replace(secret, "ID")).toBe(b.replace(ghost, "ID"));
    const c = await msg(() => submitRelink(v, claude, { target: secret, tags: ["x"] }));
    const d = await msg(() => submitRelink(v, claude, { target: ghost, tags: ["x"] }));
    expect(c.replace(secret, "ID")).toBe(d.replace(ghost, "ID"));
  });

  it("標籤詞彙表只統計看得到的條目", async () => {
    const v = await tempVault();
    await seed(v, { claim: "公開條目", tags: ["coding"] });
    await seed(v, { claim: "私密條目", tags: ["修行"], disclosure: "private" });
    const forAgent = await tagReport(v, claude, false);
    expect(forAgent).toContain("#coding（1）");
    expect(forAgent).not.toContain("修行");
    expect(await tagReport(v, keeper, false)).toContain("#修行（1）");
  });
});

describe("檢索", () => {
  it("recall 依標籤篩選，可單獨使用或搭配 query", async () => {
    const v = await tempVault();
    const a = await seed(v, { claim: "文章語氣要直接", tags: ["writing"] });
    const b = await seed(v, { claim: "部落格先列大綱", tags: ["writing", "blog"] });
    const c = await seed(v, { claim: "程式碼先寫測試", tags: ["coding"] });
    const onlyTags = await recall(v, claude, { tags: ["Writing"] });
    expect(onlyTags).toContain(a);
    expect(onlyTags).toContain(b);
    expect(onlyTags).not.toContain(c);
    const both = await recall(v, claude, { tags: ["writing", "blog"] });
    expect(both).toContain(b);
    expect(both).not.toContain(a);
    const withQuery = await recall(v, claude, { query: "語氣", tags: ["writing"] });
    expect(withQuery).toContain(a);
    expect(withQuery).not.toContain(b);
    expect(await recall(v, claude, { tags: ["nope"] })).toContain("沒有符合「#nope」");
  });

  it("標籤可被關鍵字檢索命中，也出現在索引行", async () => {
    const v = await tempVault();
    const id = await seed(v, { claim: "喜歡爬山", tags: ["hiking"] });
    expect(await recall(v, claude, { query: "hiking" })).toContain(id);
    expect(await getContext(v, claude, "週末")).toContain("喜歡爬山 #hiking");
  });
});

describe("Keeper 整理", () => {
  it("suggestLinks：列出相似但尚未關聯的條目對", async () => {
    const v = await tempVault();
    const a = await seed(v, { claim: "A" });
    const b = await seed(v, { claim: "B" });
    const c = await seed(v, { claim: "C", links: [{ to: a, rel: "related" }] });
    const mems = await Promise.all([a, b, c].map(async (id) => (await v.readMemory(id))!));
    const vectors = [
      [1, 0],
      [0.9, 0.1],
      [1, 0],
    ].map((x) => Float32Array.from(x));
    const s = suggestLinks(mems, { vectors, minSimilarity: 0.5 });
    const pairs = s.map((x) => [x.a.meta.id, x.b.meta.id].sort().join());
    expect(pairs).toContain([a, b].sort().join());
    expect(pairs).toContain([b, c].sort().join());
    expect(pairs).not.toContain([a, c].sort().join()); // 已有關聯
  });

  it("沒有 embedding 時以 BM25 找相似條目", async () => {
    const v = await tempVault();
    await seed(v, { claim: "code review 時先給結論再展開細節" });
    await seed(v, { claim: "code review 先給結論" });
    await seed(v, { claim: "週末喜歡爬山" });
    const report = await linkSuggestionReport(v);
    expect(report).toContain("BM25");
    expect(report).toContain("先給結論再展開");
    expect(report).not.toContain("爬山");
  });

  it("標籤詞彙表與同義候選", () => {
    const usage = tagUsage([
      { meta: { tags: ["writing", "coding"] } },
      { meta: { tags: ["writing"] } },
    ] as never);
    expect(usage).toEqual([
      { tag: "writing", count: 2 },
      { tag: "coding", count: 1 },
    ]);
    const vecs = [
      [1, 0],
      [0.95, 0.05],
      [0, 1],
    ].map((x) => Float32Array.from(x));
    expect(similarTags(["writing", "寫作", "coding"], vecs)).toEqual([
      { a: "writing", b: "寫作", similarity: expect.any(Number) },
    ]);
  });
});
