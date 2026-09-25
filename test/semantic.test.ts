import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getContext, recall } from "../src/context.js";
import { HttpEmbedder, semanticFromEnv, type Embedder } from "../src/embed.js";
import { mergeProposal, submitProposal, type SubmitInput } from "../src/proposals.js";
import { fuse } from "../src/search.js";
import type { Vault } from "../src/vault.js";
import { claude, keeper, quote, tempVault } from "./helpers.js";

/** 假的 embedder：每個概念一維，查詢與文件只要提到同一概念就相似（模擬跨語言與同義） */
const CONCEPTS = [/咖啡|coffee|早餐飲料/i, /文章|語氣|寫作|writing/i, /備份|backup/i];

class FakeEmbedder implements Embedder {
  calls: { texts: string[]; kind: string }[] = [];
  constructor(readonly model = "fake-v1") {}
  async embed(texts: string[], kind: "query" | "document") {
    this.calls.push({ texts, kind });
    return texts.map((t) => [...CONCEPTS.map((re) => (re.test(t) ? 1 : 0)), 0.05]);
  }
  documentCalls() {
    return this.calls.filter((c) => c.kind === "document");
  }
}

class BrokenEmbedder implements Embedder {
  model = "broken";
  async embed(): Promise<number[][]> {
    throw new Error("connection refused");
  }
}

async function seed(v: Vault, input: Partial<SubmitInput> & { claim: string }) {
  const { proposal } = await submitProposal(v, claude, {
    kind: "preference",
    voice: "stated",
    suggested_layer: "preference",
    confidence: 0.7,
    evidence: quote(input.claim),
    ...input,
  });
  return (await mergeProposal(v, keeper, proposal)).memory;
}

describe("fuse", () => {
  const opts = { alpha: 0.5, minCosine: 0.4 };

  it("沒有語意分數時原樣回傳 BM25", () => {
    expect(fuse([3, 1, 0], null, opts)).toEqual([3, 1, 0]);
  });

  it("BM25 以最高分正規化，cosine 低於下限不計", () => {
    const s = fuse([4, 2, 0, 0], [0.1, 0.1, 0.8, 0.39], opts);
    expect(s[0]).toBeCloseTo(0.5);
    expect(s[1]).toBeCloseTo(0.25);
    expect(s[2]).toBeCloseTo(0.5); // 只有語意命中
    expect(s[3]).toBe(0); // 低於絕對下限
  });

  it("alpha=1 等同 BM25 排序；alpha=0 只看語意", () => {
    const bm = [4, 2, 0];
    const cos = [0.1, 0.9, 0.8];
    const pure = fuse(bm, cos, { alpha: 1, minCosine: 0.4 });
    expect(pure.map((x) => x * 4)).toEqual(bm);
    const sem = fuse(bm, cos, { alpha: 0, minCosine: 0.4 });
    expect(sem[0]).toBe(0);
    expect(sem[1]).toBeGreaterThan(sem[2]!);
  });

  it("最高 cosine 貼近下限時不把微小差距放大", () => {
    const s = fuse([0, 0, 0], [0.4, 0.405, 0.41], opts);
    expect(s[0]).toBe(0);
    expect(s[1]).toBeCloseTo(0.5 * 0.05);
    expect(s[2]).toBeCloseTo(0.5 * 0.1);
  });

  it("兩者皆命中者排最前", () => {
    const s = fuse([2, 2, 0], [0.9, 0.2, 0.9], opts);
    expect(s[0]).toBeGreaterThan(s[1]!);
    expect(s[0]).toBeGreaterThan(s[2]!);
  });
});

describe("語意檢索", () => {
  it("跨語言與同義查詢能命中", async () => {
    const v = await tempVault();
    const coffee = await seed(v, { claim: "早上習慣喝黑咖啡，不加糖" });
    const style = await seed(v, { claim: "文章語氣要直接" });
    expect(await recall(v, claude, { query: "coffee" })).toContain("沒有符合");

    v.enableSemantic(new FakeEmbedder());
    const en = await recall(v, claude, { query: "coffee" });
    expect(en).toContain(coffee);
    expect(en).not.toContain(style);
    const syn = await recall(v, claude, { query: "寫作風格" });
    expect(syn).toContain(style);
    expect(syn).not.toContain(coffee);
  });

  it("完全無關的查詢不會因語意而混入結果", async () => {
    const v = await tempVault();
    await seed(v, { claim: "早上習慣喝黑咖啡，不加糖" });
    v.enableSemantic(new FakeEmbedder());
    expect(await recall(v, claude, { query: "天氣預報" })).toContain("沒有符合");
  });

  it("embedder 失效時退回 BM25，不讓 recall 失敗", async () => {
    const v = await tempVault();
    const id = await seed(v, { claim: "code review 先給結論" });
    v.enableSemantic(new BrokenEmbedder());
    expect(await recall(v, claude, { query: "結論" })).toContain(id);
    expect(await recall(v, claude, { query: "coffee" })).toContain("沒有符合");
  });

  it("看不到的條目不會經由語意命中而洩漏", async () => {
    const v = await tempVault();
    await seed(v, { claim: "私下的咖啡因戒斷紀錄", disclosure: "private" });
    v.enableSemantic(new FakeEmbedder());
    expect(await recall(v, claude, { query: "coffee" })).toContain("沒有符合");
  });

  it("get_context 依混合分數排序", async () => {
    const v = await tempVault();
    await seed(v, { claim: "文章語氣要直接" });
    await seed(v, { claim: "早上習慣喝黑咖啡，不加糖" });
    v.enableSemantic(new FakeEmbedder());
    const ctx = await getContext(v, claude, "coffee");
    expect(ctx.indexOf("黑咖啡")).toBeLessThan(ctx.indexOf("文章語氣"));
  });
});

describe("向量快取", () => {
  it("只重算有變動的條目；模型改變時整批失效；不進版本控制", async () => {
    const v = await tempVault();
    await seed(v, { claim: "早上習慣喝黑咖啡，不加糖" });
    const fake = new FakeEmbedder();
    v.enableSemantic(fake);
    await recall(v, claude, { query: "coffee" });
    expect(fake.documentCalls()).toHaveLength(1);

    await recall(v, claude, { query: "backup" });
    expect(fake.documentCalls()).toHaveLength(1); // 快取命中

    await seed(v, { claim: "重要資料異動前必須先備份" });
    await recall(v, claude, { query: "backup" });
    expect(fake.documentCalls()).toHaveLength(2);
    expect(fake.documentCalls()[1]!.texts).toHaveLength(1); // 只補算新條目

    const file = path.join(v.root, ".index", "embeddings.json");
    expect(JSON.parse(await readFile(file, "utf8")).model).toBe("fake-v1");
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readFile(path.join(v.root, ".index", ".gitignore"), "utf8")).toContain("*");

    const next = new FakeEmbedder("fake-v2");
    v.enableSemantic(next);
    await recall(v, claude, { query: "coffee" });
    expect(next.documentCalls()[0]!.texts).toHaveLength(2); // 整批重算
  });

  it("快取檔損壞時重建，不讓 recall 失敗", async () => {
    const v = await tempVault();
    const id = await seed(v, { claim: "早上習慣喝黑咖啡，不加糖" });
    await mkdir(path.join(v.root, ".index"), { recursive: true });
    await writeFile(path.join(v.root, ".index", "embeddings.json"), "{not json");
    const fake = new FakeEmbedder();
    v.enableSemantic(fake);
    expect(await recall(v, claude, { query: "coffee" })).toContain(id);
    expect(JSON.parse(await readFile(path.join(v.root, ".index", "embeddings.json"), "utf8")).model).toBe("fake-v1");
  });

  it("送去 embedding 的文字有長度上限", async () => {
    const v = await tempVault();
    await seed(v, { claim: "長證據", evidence: [{ source: "chat", quote: "咖啡".repeat(5000), at: "2026-01-01T00:00:00Z" }] });
    const fake = new FakeEmbedder();
    v.enableSemantic(fake);
    await recall(v, claude, { query: "coffee" });
    expect(Math.max(...fake.documentCalls()[0]!.texts.map((t) => t.length))).toBeLessThanOrEqual(2000);
  });

  it("不同權限的呼叫者共用同一份快取", async () => {
    const v = await tempVault();
    await seed(v, { claim: "早上習慣喝黑咖啡，不加糖" });
    await seed(v, { claim: "私下的備份習慣", disclosure: "private" });
    const fake = new FakeEmbedder();
    v.enableSemantic(fake);
    await recall(v, claude, { query: "coffee" });
    await recall(v, keeper, { query: "backup" });
    await recall(v, claude, { query: "coffee" });
    expect(fake.documentCalls()).toHaveLength(1);
  });
});

describe("設定", () => {
  it("未設定時不啟用；有設定時解析參數", () => {
    expect(semanticFromEnv({})).toBeNull();
    const s = semanticFromEnv({
      SUBSTRATE_EMBED_URL: "http://127.0.0.1:11434",
      SUBSTRATE_EMBED_MODEL: "qwen3-embedding:0.6b",
      SUBSTRATE_EMBED_ALPHA: "0.3",
    });
    expect(s?.embedder.model).toBe("qwen3-embedding:0.6b");
    expect(s?.options).toEqual({ alpha: 0.3, minCosine: 0.4 });
  });

  it("OpenAI 相容端點的結尾斜線會被正規化", async () => {
    const seen: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    }) as typeof fetch;
    try {
      await new HttpEmbedder({ url: "http://x/v1/embeddings/", model: "m" }).embed(["a"], "query");
      await new HttpEmbedder({ url: "http://x:11434/", model: "m" }).embed(["a"], "query").catch(() => undefined);
    } finally {
      globalThis.fetch = orig;
    }
    expect(seen).toEqual(["http://x/v1/embeddings", "http://x:11434/api/embed"]);
  });

  it("連不上端點時拋錯（由 SemanticIndex 接住）", async () => {
    const e = new HttpEmbedder({ url: "http://127.0.0.1:9", model: "x", timeoutMs: 500 });
    await expect(e.embed(["a"], "query")).rejects.toThrow();
  });
});
