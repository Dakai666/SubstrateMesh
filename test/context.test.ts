import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInstructions, getContext, recall, tokenize } from "../src/context.js";
import { mergeProposal, submitProposal, type SubmitInput } from "../src/proposals.js";
import type { Vault } from "../src/vault.js";
import { claude, keeper, loom, quote, tempVault } from "./helpers.js";

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

describe("tokenize", () => {
  it("拉丁字詞 + CJK 二字組", () => {
    const t = tokenize("Code review 要先給結論");
    expect(t.has("code")).toBe(true);
    expect(t.has("結論")).toBe(true);
  });
});

describe("getContext", () => {
  it("依揭露分級與 agent 範圍過濾", async () => {
    const v = await tempVault();
    await seed(v, { claim: "偏好繁體中文回覆", disclosure: "card" });
    await seed(v, { claim: "修行細節僅限私密", disclosure: "private" });
    await seed(v, { claim: "對 hermes 可以更隨性", scope: { agents: ["hermes"] } });

    const forClaude = await getContext(v, claude, "寫程式");
    expect(forClaude).toContain("偏好繁體中文回覆");
    expect(forClaude).not.toContain("修行細節");
    expect(forClaude).not.toContain("hermes 可以更隨性");

    const forLoom = await getContext(v, loom, "寫程式");
    expect(forLoom).toContain("偏好繁體中文回覆");

    const forHermes = await getContext(v, { ...claude, name: "hermes" }, "閒聊");
    expect(forHermes).toContain("hermes 可以更隨性");
  });

  it("憲法層優先並全文提供；推測被標示", async () => {
    const v = await tempVault();
    await writeFile(
      path.join(v.root, "constitution", "autonomy.md"),
      "---\ntitle: 自主邊界與紅線\ndisclosure: card\n---\n- 重要資料異動前必須先備份\n",
    );
    await seed(v, { claim: "可能偏好循環式的宇宙觀", voice: "inferred", suggested_layer: "experience" });
    const ctx = await getContext(v, claude, "整理資料");
    expect(ctx.indexOf("自主邊界與紅線")).toBeLessThan(ctx.indexOf("循環式"));
    expect(ctx).toContain("重要資料異動前必須先備份");
    expect(ctx).toMatch(/推測.*循環式/);
  });

  it("超出預算時提示改用 recall", async () => {
    const v = await tempVault();
    for (let i = 0; i < 8; i++) await seed(v, { claim: `第 ${i} 條很長的偏好描述，用來測試預算截斷的行為是否正確` });
    const ctx = await getContext(v, claude, "任務", 200);
    expect(ctx).toMatch(/另有 \d+ 條未列出/);
  });
});

describe("recall", () => {
  it("以 id 取得證據原話，以 query 查詢", async () => {
    const v = await tempVault();
    const id = await seed(v, { claim: "code review 先給結論", scope: { domain: "coding" } });
    await seed(v, { claim: "文章語氣要直接", scope: { domain: "writing" } });
    const detail = await recall(v, claude, { id });
    expect(detail).toContain("「code review 先給結論」");
    const found = await recall(v, claude, { query: "結論" });
    expect(found).toContain(id);
    expect(found).not.toContain("文章語氣");
  });

  it("無權存取時不洩漏內容", async () => {
    const v = await tempVault();
    const id = await seed(v, { claim: "私密條目", disclosure: "private" });
    expect(await recall(v, claude, { id })).toContain("無權存取");
  });
});

describe("buildInstructions", () => {
  it("只注入名片等級，並附使用守則", async () => {
    const v = await tempVault();
    await seed(v, { claim: "偏好繁體中文回覆", disclosure: "card" });
    await seed(v, { claim: "畫像等級的偏好", disclosure: "profile" });
    const ins = await buildInstructions(v, claude);
    expect(ins).toContain("懂使用者，但不自以為懂");
    expect(ins).toContain("偏好繁體中文回覆");
    expect(ins).not.toContain("畫像等級的偏好");
  });
});
