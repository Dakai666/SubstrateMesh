import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import {
  PolicyError,
  expireMemories,
  mergeProposal,
  submitProposal,
  transitionProposal,
} from "../src/proposals.js";
import { claude, keeper, quote, tempVault, user } from "./helpers.js";

const pref = {
  claim: "回覆程式問題時，先給結論再展開細節",
  kind: "preference" as const,
  voice: "stated" as const,
  suggested_layer: "preference" as const,
  confidence: 0.7,
  scope: { domain: "coding" },
};

describe("vault init", () => {
  it("建立目錄結構、範本並做第一次 commit", async () => {
    const v = await tempVault();
    const keeperSpec = await readFile(path.join(v.root, ".keeper/KEEPER.md"), "utf8");
    expect(keeperSpec).toContain("硬性不變式");
    expect(await git(v.root, ["log", "--oneline"])).toContain("vault: initialize");
  });
});

describe("submitProposal", () => {
  it("寫入提案檔、原始事件，並提交到 git", async () => {
    const v = await tempVault();
    const r = await submitProposal(v, claude, { ...pref, evidence: quote("以後開頭先給結論"), session: "s1" });
    const p = await v.readProposal(r.proposal);
    expect(p?.meta.status).toBe("pending");
    expect(p?.meta.proposer).toBe("claude-code");
    expect(p?.meta.evidence[0].quote).toBe("以後開頭先給結論");
    const raw = await readFile(path.join(v.root, "raw", `${v.nowIso().slice(0, 7)}.jsonl`), "utf8");
    expect(raw).toContain("proposal.submitted");
    expect(await git(v.root, ["log", "--oneline"])).toContain(`submit ${r.proposal}`);
  });

  it("推測不能進入憲法層", async () => {
    const v = await tempVault();
    await expect(
      submitProposal(v, claude, { ...pref, voice: "inferred", suggested_layer: "constitution" }),
    ).rejects.toBeInstanceOf(PolicyError);
  });

  it("沒有原話時提醒會降低權重", async () => {
    const v = await tempVault();
    const r = await submitProposal(v, claude, pref);
    expect(r.notes.join()).toContain("原話");
  });

  it("相同主張的待審提案會被併入作為佐證", async () => {
    const v = await tempVault();
    const a = await submitProposal(v, claude, { ...pref, evidence: quote("先給結論", "claude-code/s1") });
    const b = await submitProposal(v, { ...claude, name: "opencode" }, {
      ...pref,
      claim: "回覆程式問題時，先給結論，再展開細節。",
      evidence: quote("結論先講", "opencode/s9"),
    });
    expect(b.proposal).toBe(a.proposal);
    const p = await v.readProposal(a.proposal);
    expect(p?.meta.evidence).toHaveLength(2);
    expect(p?.thread.at(-1)?.author).toBe("opencode");
    expect(await v.listProposals()).toHaveLength(1);
  });

  it("曾被拒絕的主張再次提交時附上前次理由", async () => {
    const v = await tempVault();
    const a = await submitProposal(v, claude, pref);
    await transitionProposal(v, keeper, a.proposal, "rejected", "只是一次性的情緒");
    const b = await submitProposal(v, claude, pref);
    expect(b.proposal).not.toBe(a.proposal);
    expect(b.notes.join()).toContain("一次性的情緒");
  });
});

describe("審查與合併", () => {
  it("Keeper 合併後建立知識條目", async () => {
    const v = await tempVault();
    const { proposal } = await submitProposal(v, claude, { ...pref, evidence: quote("先給結論") });
    const { memory } = await mergeProposal(v, keeper, proposal, "兩次獨立佐證");
    const m = await v.readMemory(memory);
    expect(m?.meta.claim).toBe(pref.claim);
    expect(m?.meta.evidence[0].proposal).toBe(proposal);
    const p = await v.readProposal(proposal);
    expect(p?.meta.status).toBe("merged");
    expect(p?.meta.resolution?.memory).toBe(memory);
  });

  it("一般 agent 不能審查", async () => {
    const v = await tempVault();
    const { proposal } = await submitProposal(v, claude, pref);
    await expect(mergeProposal(v, claude, proposal)).rejects.toThrow(/Keeper/);
  });

  it("職責分離：Keeper 不能合併自己的提案", async () => {
    const v = await tempVault();
    const { proposal } = await submitProposal(v, keeper, pref);
    await expect(mergeProposal(v, keeper, proposal)).rejects.toThrow(/職責分離/);
    await expect(mergeProposal(v, user, proposal)).resolves.toBeTruthy();
  });

  it("觸及憲法層只能由使用者合併", async () => {
    const v = await tempVault();
    const { proposal } = await submitProposal(v, claude, {
      ...pref,
      claim: "出錯時要減速、重新對齊，而不是加速補救",
      kind: "principle",
      suggested_layer: "constitution",
    });
    await expect(mergeProposal(v, keeper, proposal)).rejects.toThrow(/憲法層/);
    await transitionProposal(v, keeper, proposal, "escalated", "這是紅線級原則，請確認");
    const { memory } = await mergeProposal(v, user, proposal);
    expect((await v.readMemory(memory))?.meta.layer).toBe("constitution");
  });

  it("Keeper 不能用 overrides 把推測升到憲法層", async () => {
    const v = await tempVault();
    const { proposal } = await submitProposal(v, claude, { ...pref, voice: "inferred" });
    await expect(mergeProposal(v, user, proposal, undefined, { layer: "constitution" })).rejects.toThrow(
      /推測/,
    );
  });

  it("與既有知識相同的提案轉為強化佐證", async () => {
    const v = await tempVault();
    const first = await submitProposal(v, claude, { ...pref, confidence: 0.6, evidence: quote("先給結論") });
    const { memory } = await mergeProposal(v, keeper, first.proposal);
    const again = await submitProposal(v, { ...claude, name: "hermes" }, {
      ...pref,
      confidence: 0.8,
      evidence: quote("一樣，結論先", "hermes/s2"),
    });
    const p = await v.readProposal(again.proposal);
    expect(p?.meta.action).toBe("update");
    expect(p?.meta.target).toBe(memory);
    await mergeProposal(v, keeper, again.proposal);
    const m = await v.readMemory(memory);
    expect(m?.meta.evidence).toHaveLength(2);
    expect(m?.meta.confidence).toBe(0.8);
  });

  it("supersede：舊知識標記為過去，而不是刪除", async () => {
    const v = await tempVault();
    const a = await submitProposal(v, claude, { ...pref, claim: "偏好用 Python 寫工具" });
    const { memory: old } = await mergeProposal(v, keeper, a.proposal);
    const b = await submitProposal(v, claude, {
      ...pref,
      claim: "改用 TypeScript 寫工具",
      action: "supersede",
      target: old,
    });
    const { memory: fresh } = await mergeProposal(v, keeper, b.proposal);
    expect((await v.readMemory(old))?.meta.status).toBe("superseded");
    expect((await v.readMemory(fresh))?.meta.supersedes).toEqual([old]);
  });

  it("已結案的提案不能再審查", async () => {
    const v = await tempVault();
    const { proposal } = await submitProposal(v, claude, pref);
    await transitionProposal(v, keeper, proposal, "rejected", "不成立");
    await expect(mergeProposal(v, user, proposal)).rejects.toThrow(/rejected/);
  });
});

describe("代謝", () => {
  it("TTL 到期的知識被封存", async () => {
    const clock = { now: new Date("2026-09-01T00:00:00Z") };
    const v = await tempVault(clock);
    const { proposal } = await submitProposal(v, claude, {
      ...pref,
      claim: "這陣子專注在 SubstrateMesh",
      kind: "focus",
      suggested_layer: "experience",
      ttl: "30d",
    });
    const { memory } = await mergeProposal(v, keeper, proposal);
    expect(await expireMemories(v, keeper)).toEqual([]);
    clock.now = new Date("2026-10-02T00:00:00Z");
    expect(await expireMemories(v, keeper)).toEqual([memory]);
    expect((await v.readMemory(memory))?.meta.status).toBe("archived");
  });
});
