import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractYaml, importQuestionnaire } from "../src/importer.js";
import { tempVault } from "./helpers.js";

const reply = `以下是我的回答。

\`\`\`yaml
respondent: ChatGPT
memory_access: 有長期記憶功能
items:
  - claim: 偏好以結論開頭
    kind: preference
    voice: stated
    confidence: 0.8
    domain: communication
    evidence:
      - quote: 先講結論
        when: 2026 年初
  - claim: 可能是完美主義者
    kind: fact
    voice: inferred
    confidence: 0.9
  - claim: 最近在研究 MCP
    kind: focus
    voice: observed
    confidence: 0.7
  - kind: preference
tensions:
  - 要簡潔，但又喜歡深入探討哲學
\`\`\`
`;

describe("questionnaire import", () => {
  it("抽出 YAML 區塊", () => {
    expect(extractYaml(reply)).toHaveLength(1);
  });

  it("轉為低信任度提案並保存原始回覆", async () => {
    const v = await tempVault();
    const r = await importQuestionnaire(v, "ChatGPT", reply);
    expect(r.proposals).toHaveLength(3);
    expect(r.skipped).toHaveLength(1);

    const [stated, inferred, focus] = await Promise.all(r.proposals.map((id) => v.readProposal(id)));
    expect(stated?.meta.proposer).toBe("chatgpt");
    expect(stated?.meta.suggested_layer).toBe("preference");
    expect(stated?.meta.evidence[0].source).toContain("chatgpt/questionnaire-");
    expect(inferred?.meta.suggested_layer).toBe("experience");
    expect(inferred?.meta.confidence).toBe(0.6);
    expect(focus?.meta.ttl).toBe("30d");

    const raw = await readFile(path.join(v.root, r.raw), "utf8");
    expect(raw).toContain("要簡潔，但又喜歡深入探討哲學");
  });

  it("重複匯入同一來源時，相同主張併為佐證", async () => {
    const v = await tempVault();
    const a = await importQuestionnaire(v, "gemini", reply);
    const b = await importQuestionnaire(v, "gemini", reply);
    expect(b.proposals).toEqual(a.proposals);
  });
});
