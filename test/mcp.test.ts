import type { AddressInfo } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { buildServer } from "../src/server.js";
import { addToken } from "../src/tokens.js";
import type { Actor } from "../src/types.js";
import type { Vault } from "../src/vault.js";
import { claude, keeper, tempVault } from "./helpers.js";

async function connect(v: Vault, actor: Actor) {
  const server = await buildServer(v, actor, "sess-1");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const textOf = (r: unknown) =>
  ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

describe("MCP server", () => {
  it("一般 agent 只看得到讀取與提交工具", async () => {
    const v = await tempVault();
    const client = await connect(v, claude);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_context", "list_tags", "propose_links", "propose_memory", "recall", "record_example"]);
    expect(client.getInstructions()).toContain("get_context");
  });

  it("agent 提交 → Keeper 審查合併 → agent 讀得到", async () => {
    const v = await tempVault();
    const agent = await connect(v, claude);
    const submitted = textOf(
      await agent.callTool({
        name: "propose_memory",
        arguments: {
          claim: "犯錯後要減速對齊",
          kind: "principle",
          voice: "stated",
          suggested_layer: "preference",
          confidence: 0.9,
          evidence: [{ quote: "不要像怕被罵的孩子一樣加速暴衝" }],
          rationale: "使用者描述的最大失敗模式",
        },
      }),
    );
    const id = /prop_[0-9A-Z]{26}/.exec(submitted)![0];
    const p = await v.readProposal(id);
    expect(p?.meta.evidence[0].source).toBe("claude-code/sess-1");

    const k = await connect(v, keeper);
    expect(textOf(await k.callTool({ name: "list_proposals", arguments: {} }))).toContain(id);
    expect(textOf(await k.callTool({ name: "merge_proposal", arguments: { id, note: "使用者親口所述" } }))).toMatch(
      /mem_/,
    );
    expect(textOf(await agent.callTool({ name: "get_context", arguments: { task: "修 bug" } }))).toContain(
      "犯錯後要減速對齊",
    );
  });

  it("propose_links → Keeper 看到差異並合併 → recall 帶出關聯", async () => {
    const v = await tempVault();
    const agent = await connect(v, claude);
    const k = await connect(v, keeper);
    const ids: string[] = [];
    for (const claim of ["文章語氣要直接", "對長輩寫信要委婉"]) {
      const r = textOf(
        await agent.callTool({
          name: "propose_memory",
          arguments: { claim, kind: "preference", voice: "stated", suggested_layer: "preference", confidence: 0.8, tags: ["Writing"] },
        }),
      );
      const pid = /prop_[0-9A-Z]{26}/.exec(r)![0];
      ids.push(/mem_[0-9A-Z]{26}/.exec(textOf(await k.callTool({ name: "merge_proposal", arguments: { id: pid } })))![0]);
    }
    const r = textOf(
      await agent.callTool({
        name: "propose_links",
        arguments: { target: ids[1], links: [{ to: ids[0], rel: "contradicts", note: "對象不同" }] },
      }),
    );
    const pid = /prop_[0-9A-Z]{26}/.exec(r)![0];
    const shown = textOf(await k.callTool({ name: "show_proposal", arguments: { id: pid } }));
    expect(shown).toContain(`+ 關聯：⚠ 張力（contradicts）→ ${ids[0]}：對象不同`);
    await k.callTool({ name: "merge_proposal", arguments: { id: pid } });
    const detail = textOf(await agent.callTool({ name: "recall", arguments: { id: ids[0] } }));
    expect(detail).toContain(`〔⚠ 張力〕${ids[1]}`);
    expect(textOf(await agent.callTool({ name: "list_tags", arguments: {} }))).toContain("#writing（2）");
    expect(textOf(await agent.callTool({ name: "recall", arguments: { tags: ["writing"] } }))).toContain(ids[1]);

    const agentTools = (await agent.listTools()).tools.map((t) => t.name);
    expect(agentTools).not.toContain("suggest_links");
    expect(textOf(await k.callTool({ name: "suggest_links", arguments: {} }))).toMatch(/候選關聯|沒有找到/);
  });

  it("政策違規以 isError 回報，而不是丟例外", async () => {
    const v = await tempVault();
    const agent = await connect(v, claude);
    const r = await agent.callTool({
      name: "propose_memory",
      arguments: { claim: "x", kind: "fact", voice: "inferred", suggested_layer: "constitution", confidence: 0.5 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("推測");
  });
});

describe("HTTP daemon", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("沒有 token 回 401；token 決定身分", async () => {
    const v = await tempVault();
    const dir = await mkdtemp(path.join(os.tmpdir(), "substrate-tokens-"));
    const tokensFile = path.join(dir, "tokens.json");
    const token = await addToken(tokensFile, "loom", "agent", "profile");
    const server = await startHttp(v, { host: "127.0.0.1", port: 0, tokensFile });
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (await fetch(url, { method: "POST", body: "{}", headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);

    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}`, "x-substrate-session": "loom-42" } },
      }),
    );
    const r = await client.callTool({
      name: "propose_memory",
      arguments: { claim: "喜歡有話直說", kind: "preference", voice: "stated", suggested_layer: "preference", confidence: 0.9 },
    });
    const id = /prop_[0-9A-Z]{26}/.exec(textOf(r))![0];
    const p = await v.readProposal(id);
    expect(p?.meta.proposer).toBe("loom");
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("merge_proposal");
    const log = await readFile(
      path.join(v.root, ".keeper", "logs", `access-${v.nowIso().slice(0, 7)}.jsonl`),
      "utf8",
    );
    const connects = log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "connect");
    expect(connects).toEqual([
      expect.objectContaining({ actor: "loom", session: "loom-42", client: "test", client_version: "0" }),
    ]);
    await client.close();
  });
});
