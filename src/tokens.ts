import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DISCLOSURES, type Actor, type Disclosure, type Role } from "./types.js";

/**
 * Token 設定檔刻意放在 vault 之外（不進 git），且只保存 SHA-256 雜湊。
 * 身分（agent 名稱、角色、揭露權限）由 token 決定，agent 無法自報。
 */
export interface TokenEntry {
  sha256: string;
  agent: string;
  role: Exclude<Role, "user">;
  clearance: Disclosure;
  created_at: string;
}

export interface TokenFile {
  tokens: TokenEntry[];
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function loadTokens(file: string): Promise<TokenFile> {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8")) as TokenFile;
    return { tokens: Array.isArray(data.tokens) ? data.tokens : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { tokens: [] };
    throw err;
  }
}

export async function addToken(
  file: string,
  agent: string,
  role: TokenEntry["role"],
  clearance: Disclosure,
): Promise<string> {
  if (!DISCLOSURES.includes(clearance)) throw new Error(`未知的 clearance：${clearance}`);
  const data = await loadTokens(file);
  const token = `sm_${randomBytes(24).toString("base64url")}`;
  data.tokens.push({ sha256: hash(token), agent, role, clearance, created_at: new Date().toISOString() });
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return token;
}

export async function revokeToken(file: string, agent: string): Promise<number> {
  const data = await loadTokens(file);
  const before = data.tokens.length;
  data.tokens = data.tokens.filter((t) => t.agent !== agent);
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return before - data.tokens.length;
}

export function authenticate(data: TokenFile, bearer: string | undefined): Actor | null {
  if (!bearer) return null;
  const h = Buffer.from(hash(bearer), "hex");
  let found: TokenEntry | null = null;
  for (const t of data.tokens) {
    const candidate = Buffer.from(t.sha256, "hex");
    if (candidate.length === h.length && timingSafeEqual(candidate, h)) found = t;
  }
  return found ? { name: found.agent, role: found.role, clearance: found.clearance } : null;
}
