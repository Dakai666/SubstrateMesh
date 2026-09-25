#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { linkChangeSection, linkSuggestionReport, tagReport } from "./curate.js";
import { semanticFromEnv } from "./embed.js";
import { startHttp } from "./http.js";
import { importQuestionnaire } from "./importer.js";
import {
  PolicyError,
  commentProposal,
  expireMemories,
  mergeProposal,
  transitionProposal,
} from "./proposals.js";
import { buildServer, VERSION } from "./server.js";
import { addGrant, addToken, listGrants, loadTokens, parseGrantTtl, revokeGrants, revokeToken } from "./tokens.js";
import { DISCLOSURES, LAYERS, type Actor, type Disclosure, type Layer } from "./types.js";
import { Vault } from "./vault.js";
import { renderViews } from "./views.js";

const HELP = `substrate ${VERSION} — 個人上下文基質

用法：
  substrate init [vault]                         建立 vault（git repo）
  substrate serve --stdio --agent <名稱>          以 stdio 提供 MCP（單一 agent，開發用）
        [--role agent|keeper] [--clearance card|profile|private]
  substrate serve --http [--host 127.0.0.1] [--port 7077]
                                                 常駐 daemon，多 agent 以 bearer token 連線
  substrate token add <agent> [--role agent|keeper] [--clearance profile]
  substrate token list | revoke <agent>
  substrate keeper grant [--ttl 1h]              開一段審查時段授權（上限 1h）：時段內 Keeper 經你在對話中
                                                 同意後，可以合併它自己提交的提案；憲法層仍只能由你合併
  substrate keeper [grants] | revoke             列出有效授權／提早收回全部授權
  substrate proposals [list] [--status pending]  使用者審查記憶 PR
  substrate proposals show <id>
  substrate proposals merge <id> [<id> ...] [--note ..] [--layer ..]
                                                 多筆時逐筆合併；中途失敗會停下，已合併的不會回復
  substrate proposals reject|defer <id> --note <理由>
  substrate proposals comment <id> --note <內容>
  substrate import <回覆檔> --source <AI 名稱>     匯入問卷回覆，轉為記憶 PR
  substrate links suggest [--min <相似度>] [--limit 20]
                                                 列出相似但尚未建立關聯的條目（Keeper 整理用）
  substrate tags                                 標籤詞彙表與可能的同義標籤
  substrate expire                               封存到期知識
  substrate views                                重建 views/ 主題視圖

語意檢索（選用，本地 embedding；未設定則只用 BM25）：
  SUBSTRATE_EMBED_URL=http://127.0.0.1:11434 SUBSTRATE_EMBED_MODEL=qwen3-embedding:0.6b
  可選 SUBSTRATE_EMBED_ALPHA（BM25 權重，預設 0.5）、SUBSTRATE_EMBED_MIN_COSINE（預設 0.4）、
  SUBSTRATE_EMBED_QUERY_PREFIX（覆寫查詢端前綴；qwen3-embedding 會自動加）

共同參數：
  --vault <路徑>    預設為 $SUBSTRATE_VAULT 或 ~/substrate-vault
  --tokens <路徑>   預設為 $SUBSTRATE_TOKENS 或 ~/.config/substrate/tokens.json（不在 vault 內）
`;

interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function vaultPath(a: Args, positional?: string): string {
  return path.resolve(
    positional ?? str(a.flags.vault) ?? process.env.SUBSTRATE_VAULT ?? path.join(os.homedir(), "substrate-vault"),
  );
}

function tokensPath(a: Args): string {
  return path.resolve(
    str(a.flags.tokens) ??
      process.env.SUBSTRATE_TOKENS ??
      path.join(os.homedir(), ".config", "substrate", "tokens.json"),
  );
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${name} 必須是 ${allowed.join("|")}`);
  return v as T;
}

/** 依環境變數啟用語意檢索；未設定則維持純 BM25 */
function withSemantic(vault: Vault): Vault {
  const semantic = semanticFromEnv(process.env);
  if (semantic) vault.enableSemantic(semantic.embedder, semantic.options);
  return vault;
}

const USER: Actor = { name: process.env.USER ?? "user", role: "user", clearance: "private" };

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const [cmd, sub, arg, ...rest] = a._;

  switch (cmd) {
    case "init": {
      const root = vaultPath(a, sub);
      await Vault.init(root);
      console.log(`vault 已建立：${root}\n下一步：在 constitution/ 寫下你的憲法層，或執行 substrate serve。`);
      return;
    }
    case "serve": {
      const vault = withSemantic(await Vault.open(vaultPath(a)));
      if (vault.semantic) {
        const { embedder, options } = vault.semantic;
        console.error(`語意檢索：${embedder.model}（alpha=${options.alpha}，cosine 下限=${options.minCosine}）`);
      }
      if (a.flags.http) {
        const host = str(a.flags.host) ?? "127.0.0.1";
        const port = Number(str(a.flags.port) ?? 7077);
        const tokensFile = tokensPath(a);
        if (!(await loadTokens(tokensFile)).tokens.length) {
          console.error(`警告：${tokensFile} 沒有任何 token，所有連線都會被拒絕。先執行 substrate token add <agent>。`);
        }
        await startHttp(vault, { host, port, tokensFile });
        console.error(`substrate daemon 監聽 http://${host}:${port}/mcp（vault：${vault.root}）`);
        return;
      }
      const agent = str(a.flags.agent);
      if (!agent) throw new Error("stdio 模式需要 --agent <名稱>");
      const role = oneOf(str(a.flags.role), ["agent", "keeper"] as const, "agent", "role");
      const clearance = oneOf(
        str(a.flags.clearance),
        DISCLOSURES,
        role === "keeper" ? "private" : "profile",
        "clearance",
      );
      const server = await buildServer(vault, { name: agent, role, clearance }, str(a.flags.session), {
        tokensFile: tokensPath(a),
      });
      await server.connect(new StdioServerTransport());
      return;
    }
    case "token": {
      const file = tokensPath(a);
      if (sub === "add") {
        if (!arg) throw new Error("用法：substrate token add <agent>");
        const role = oneOf(str(a.flags.role), ["agent", "keeper"] as const, "agent", "role");
        const clearance = oneOf(
          str(a.flags.clearance),
          DISCLOSURES,
          role === "keeper" ? "private" : "profile",
          "clearance",
        ) as Disclosure;
        const token = await addToken(file, arg, role, clearance);
        console.log(`已建立 ${arg}（${role}／${clearance}）的 token，只會顯示這一次：\n${token}`);
        return;
      }
      if (sub === "revoke") {
        if (!arg) throw new Error("用法：substrate token revoke <agent>");
        console.log(`已撤銷 ${await revokeToken(file, arg)} 個 token。`);
        return;
      }
      for (const t of (await loadTokens(file)).tokens) {
        console.log(`${t.agent}\t${t.role}\t${t.clearance}\t${t.created_at}`);
      }
      return;
    }
    case "keeper": {
      const file = tokensPath(a);
      if (sub === "grant") {
        const { token, grant } = await addGrant(file, parseGrantTtl(str(a.flags.ttl) ?? "1h"));
        console.log(
          `已開啟審查時段授權 ${grant.id}，有效至 ${grant.expires_at}。token 只會顯示這一次：\n${token}\n` +
            "把 token 交給 Keeper；它只能在你於對話中同意後，用來合併它自己提交的提案。",
        );
        return;
      }
      if (sub === "revoke") {
        console.log(`已收回 ${await revokeGrants(file)} 個有效授權。`);
        return;
      }
      if (sub !== undefined && sub !== "grants") throw new Error(`未知的 keeper 子命令：${sub}`);
      const grants = await listGrants(file);
      if (!grants.length) console.log("沒有有效的審查時段授權。");
      for (const g of grants) console.log(`${g.id}\t至 ${g.expires_at}`);
      return;
    }
    case "proposals": {
      const vault = await Vault.open(vaultPath(a));
      const note = str(a.flags.note);
      switch (sub ?? "list") {
        case "list": {
          const status = str(a.flags.status) ?? "pending";
          const ps = (await vault.listProposals()).filter((p) => status === "all" || p.meta.status === status);
          if (!ps.length) console.log(`沒有 ${status} 的提案。`);
          for (const p of ps) {
            const m = p.meta;
            const act = m.action === "create" ? "" : `  ${m.action}→${m.target}`;
            console.log(`${m.id}  ${m.status}  ${m.suggested_layer}/${m.kind}/${m.voice}  ${m.proposer}${act}\n    ${m.claim}`);
          }
          return;
        }
        case "show": {
          const p = await vault.readProposal(arg ?? "");
          if (!p) throw new Error(`找不到提案：${arg}`);
          console.log(JSON.stringify(p.meta, null, 2));
          const changes = await linkChangeSection(vault, p);
          if (changes) console.log(`\n${changes}`);
          if (p.body) console.log(`\n${p.body}`);
          for (const e of p.thread) console.log(`\n[${e.at}] ${e.author}(${e.role})\n${e.text}`);
          return;
        }
        case "merge": {
          const layer = str(a.flags.layer) as Layer | undefined;
          if (layer && !LAYERS.includes(layer)) throw new Error(`--layer 必須是 ${LAYERS.join("|")}`);
          const ids = [arg ?? "", ...rest];
          for (const id of ids) {
            const r = await mergeProposal(vault, USER, id, note, layer ? { layer } : {});
            console.log(`已合併 ${id} → ${r.memory}`);
            for (const w of r.warnings) console.log(`  注意：${w}`);
          }
          return;
        }
        case "reject":
        case "defer": {
          await transitionProposal(vault, USER, arg ?? "", sub === "reject" ? "rejected" : "deferred", note ?? "");
          console.log(`${arg} → ${sub === "reject" ? "rejected" : "deferred"}`);
          return;
        }
        case "comment": {
          await commentProposal(vault, USER, arg ?? "", note ?? "");
          console.log("已留言。");
          return;
        }
        default:
          throw new Error(`未知的 proposals 子命令：${sub}`);
      }
    }
    case "import": {
      const source = str(a.flags.source);
      if (!sub || !source) throw new Error("用法：substrate import <回覆檔> --source <AI 名稱>");
      const vault = await Vault.open(vaultPath(a));
      const r = await importQuestionnaire(vault, source, await readFile(sub, "utf8"));
      console.log(`原始回覆：${r.raw}\n已建立 ${r.proposals.length} 筆提案。`);
      for (const s of r.skipped) console.log(`略過第 ${s.index + 1} 項：${s.reason}`);
      return;
    }
    case "links": {
      if (sub !== "suggest") throw new Error("用法：substrate links suggest [--min <相似度>] [--limit 20]");
      const vault = withSemantic(await Vault.open(vaultPath(a)));
      const min = str(a.flags.min);
      const limit = str(a.flags.limit);
      console.log(
        await linkSuggestionReport(vault, {
          minSimilarity: min === undefined ? undefined : Number(min),
          limit: limit === undefined ? undefined : Number(limit),
        }),
      );
      return;
    }
    case "tags": {
      console.log(await tagReport(withSemantic(await Vault.open(vaultPath(a))), USER, true));
      return;
    }
    case "expire": {
      const ids = await expireMemories(await Vault.open(vaultPath(a)), USER);
      console.log(ids.length ? `已封存：${ids.join(", ")}` : "沒有到期的知識。");
      return;
    }
    case "views": {
      const written = await renderViews(await Vault.open(vaultPath(a)));
      console.log(`已生成：${written.join(", ")}`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err instanceof PolicyError ? `拒絕：${err.message}` : `錯誤：${(err as Error).message}`);
  process.exit(1);
});
