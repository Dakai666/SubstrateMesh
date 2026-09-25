import { promises as fs } from "node:fs";
import path from "node:path";
import { isActive } from "./context.js";
import type { Memory } from "./types.js";
import type { Vault } from "./vault.js";

const LAYER_TITLE = { constitution: "憲法層", preference: "偏好層", experience: "經驗層" } as const;
const VOICE = { stated: "你說的", observed: "觀察", inferred: "推測" } as const;

/**
 * 生成給人閱讀的主題視圖（views/*.md）。視圖可隨時由正本重建，請勿手改。
 */
export async function renderViews(vault: Vault): Promise<string[]> {
  return vault.write("views: regenerate", async () => {
    const written = await writeViews(vault);
    return { result: written, paths: written };
  });
}

async function writeViews(vault: Vault): Promise<string[]> {
  const now = vault.now();
  const mems = (await vault.listMemories()).filter((m) => isActive(m.meta, now));
  const written: string[] = [];
  const header = `<!-- 由 substrate views 自動生成於 ${vault.nowIso()}；請勿手改 -->\n\n`;

  for (const layer of ["constitution", "preference", "experience"] as const) {
    const items = mems.filter((m) => m.meta.layer === layer);
    const byDomain = new Map<string, Memory[]>();
    for (const m of items) {
      const d = m.meta.scope.domain ?? "（不限領域）";
      byDomain.set(d, [...(byDomain.get(d) ?? []), m]);
    }
    const parts = [`${header}# ${LAYER_TITLE[layer]}\n`];
    if (!items.length) parts.push("（尚無條目）\n");
    for (const [domain, list] of [...byDomain].sort(([a], [b]) => a.localeCompare(b))) {
      parts.push(`## ${domain}\n`);
      for (const m of list.sort((a, b) => b.meta.confidence - a.meta.confidence)) {
        const ctx = m.meta.scope.contexts.length ? `（情境：${m.meta.scope.contexts.join("、")}）` : "";
        const who = m.meta.scope.agents.includes("*") ? "" : `〔僅 ${m.meta.scope.agents.join("、")}〕`;
        const tags = m.meta.tags.length ? ` ${m.meta.tags.map((t) => `#${t}`).join(" ")}` : "";
        parts.push(
          `- ${m.meta.claim}${ctx}${who}${tags} — ${VOICE[m.meta.voice]}·${m.meta.confidence}·${m.meta.disclosure} \`${m.meta.id}\``,
        );
      }
      parts.push("");
    }
    const rel = path.join("views", `${layer}.md`);
    await fs.writeFile(path.join(vault.root, rel), parts.join("\n"));
    written.push(rel);
  }

  const open = (await vault.listProposals()).filter((p) =>
    ["pending", "deferred", "escalated"].includes(p.meta.status),
  );
  const inbox = [`${header}# 待審提案\n`];
  for (const status of ["escalated", "pending", "deferred"] as const) {
    const list = open.filter((p) => p.meta.status === status);
    if (!list.length) continue;
    inbox.push(`## ${status}（${list.length}）\n`);
    for (const p of list) {
      inbox.push(`- \`${p.meta.id}\` ${p.meta.claim} — ${p.meta.proposer}·${VOICE[p.meta.voice]}·${p.meta.suggested_layer}`);
    }
    inbox.push("");
  }
  if (!open.length) inbox.push("（沒有待審提案）\n");
  const inboxRel = path.join("views", "inbox.md");
  await fs.writeFile(path.join(vault.root, inboxRel), inbox.join("\n"));
  written.push(inboxRel);
  return written;
}
