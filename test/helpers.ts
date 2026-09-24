import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Actor } from "../src/types.js";
import { Vault } from "../src/vault.js";

export async function tempVault(clock?: { now: Date }): Promise<Vault> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "substrate-test-"));
  await Vault.init(dir);
  return clock ? new Vault(dir, () => clock.now) : new Vault(dir);
}

export const claude: Actor = { name: "claude-code", role: "agent", clearance: "profile" };
export const loom: Actor = { name: "loom", role: "agent", clearance: "card" };
export const keeper: Actor = { name: "keeper", role: "keeper", clearance: "private" };
export const user: Actor = { name: "me", role: "user", clearance: "private" };

export const quote = (q: string, source = "claude-code/s1") => [{ quote: q, source }];
