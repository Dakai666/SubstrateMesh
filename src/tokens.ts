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

/**
 * 審查時段授權：使用者以 CLI 產生、短時效。持有者（Keeper）在時段內可以合併自己提交的提案——
 * 前提是使用者已在對話中逐條討論並同意；「是否討論過」由 Keeper 規格約束，程式只保證使用者開了授權窗口。
 * 同樣只保存雜湊；`id` 是雜湊前綴，用於紀錄，無法反推 token。
 */
export interface GrantEntry {
  id: string;
  sha256: string;
  created_at: string;
  expires_at: string;
}

export interface TokenFile {
  tokens: TokenEntry[];
  grants?: GrantEntry[];
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function loadTokens(file: string): Promise<TokenFile> {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8")) as TokenFile;
    return {
      tokens: Array.isArray(data.tokens) ? data.tokens : [],
      grants: Array.isArray(data.grants) ? data.grants : [],
    };
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
  await saveTokens(file, data);
  return token;
}

async function saveTokens(file: string, data: TokenFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export async function revokeToken(file: string, agent: string): Promise<number> {
  const data = await loadTokens(file);
  const before = data.tokens.length;
  data.tokens = data.tokens.filter((t) => t.agent !== agent);
  await saveTokens(file, data);
  return before - data.tokens.length;
}

/** 授權時段上限：這是「使用者正在場」的窗口，不是長期權限 */
export const GRANT_MAX_MINUTES = 8 * 60;

/** 解析 "30m"、"1h"；超出上限或格式錯誤時丟出例外 */
export function parseGrantTtl(ttl: string): number {
  const m = /^(\d+)([mh])$/.exec(ttl);
  if (!m) throw new Error(`--ttl 格式應為 30m 或 1h：${ttl}`);
  const minutes = Number(m[1]) * (m[2] === "h" ? 60 : 1);
  if (minutes < 1 || minutes > GRANT_MAX_MINUTES) {
    throw new Error(`--ttl 必須介於 1m 與 ${GRANT_MAX_MINUTES / 60}h 之間`);
  }
  return minutes;
}

const active = (g: GrantEntry, now: Date) => Date.parse(g.expires_at) > now.getTime();

export async function addGrant(
  file: string,
  minutes: number,
  now = new Date(),
): Promise<{ token: string; grant: GrantEntry }> {
  const data = await loadTokens(file);
  const token = `sg_${randomBytes(24).toString("base64url")}`;
  const sha256 = hash(token);
  const grant: GrantEntry = {
    id: `grant_${sha256.slice(0, 12)}`,
    sha256,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
  };
  // 順手清掉過期的，檔案不會無限增長
  data.grants = [...(data.grants ?? []).filter((g) => active(g, now)), grant];
  await saveTokens(file, data);
  return { token, grant };
}

export async function listGrants(file: string, now = new Date()): Promise<GrantEntry[]> {
  return ((await loadTokens(file)).grants ?? []).filter((g) => active(g, now));
}

/** 收回所有授權（含未過期的），回傳收回的有效授權數 */
export async function revokeGrants(file: string, now = new Date()): Promise<number> {
  const data = await loadTokens(file);
  const n = (data.grants ?? []).filter((g) => active(g, now)).length;
  data.grants = [];
  await saveTokens(file, data);
  return n;
}

/** 驗證授權 token；無效或過期回傳 null */
export function verifyGrant(data: TokenFile, token: string, now = new Date()): GrantEntry | null {
  const h = Buffer.from(hash(token), "hex");
  let found: GrantEntry | null = null;
  for (const g of data.grants ?? []) {
    const candidate = Buffer.from(g.sha256, "hex");
    if (candidate.length === h.length && timingSafeEqual(candidate, h)) found = g;
  }
  return found && active(found, now) ? found : null;
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
