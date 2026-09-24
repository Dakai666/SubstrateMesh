import { createServer, type IncomingMessage, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { authenticate, loadTokens } from "./tokens.js";
import type { Vault } from "./vault.js";

export interface HttpOptions {
  host: string;
  port: number;
  tokensFile: string;
}

const MAX_BODY = 1_000_000;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * 常駐 daemon 的 MCP 端點（Streamable HTTP，無狀態模式）。
 * 每個請求都重新驗證 token、依身分建立 server，因此 instructions 永遠反映 vault 最新狀態。
 */
export function startHttp(vault: Vault, opts: HttpOptions): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
    const actor = authenticate(await loadTokens(opts.tokensFile), bearer);
    if (!actor) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end("unauthorized");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    try {
      const body = await readJson(req);
      const session = req.headers["x-substrate-session"];
      const mcp = await buildServer(vault, actor, typeof session === "string" ? session : undefined);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null }),
        );
      }
    }
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host, () => resolve(server)));
}
