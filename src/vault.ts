import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monotonicFactory } from "ulid";
import { commitPaths, git, isRepo } from "./git.js";
import { joinThread, parseFrontmatter, splitThread, stringifyFrontmatter } from "./markdown.js";
import {
  MemorySchema,
  ProposalSchema,
  type Memory,
  type MemoryMeta,
  type Proposal,
  type ProposalMeta,
} from "./types.js";

const ulid = monotonicFactory();
export const newMemoryId = () => `mem_${ulid()}`;
export const newProposalId = () => `prop_${ulid()}`;

export const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

const DIRS = ["constitution", "memory", "projects", "raw", "proposals", "views", ".keeper"];

export interface ConstitutionDoc {
  file: string;
  title: string;
  disclosure: "card" | "profile" | "private";
  body: string;
}

export interface RawEvent {
  type: string;
  actor: string;
  session?: string;
  [key: string]: unknown;
}

/**
 * Vault：記憶本體，一個由純文字檔構成的 git repo。
 * 所有寫入都經過同一個佇列序列化，並逐次提交到 git。
 */
export class Vault {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    readonly now: () => Date = () => new Date(),
  ) {}

  static async init(root: string): Promise<Vault> {
    await fs.mkdir(root, { recursive: true });
    for (const d of DIRS) await fs.mkdir(path.join(root, d), { recursive: true });
    const copies: [string, string][] = [
      ["KEEPER.md", ".keeper/KEEPER.md"],
      ["policy.yaml", ".keeper/policy.yaml"],
      ["constitution-README.md", "constitution/README.md"],
      ["vault-gitignore", ".gitignore"],
    ];
    for (const [src, dst] of copies) {
      const target = path.join(root, dst);
      if (!(await exists(target))) {
        await fs.copyFile(path.join(TEMPLATES_DIR, src), target);
      }
    }
    for (const d of ["memory", "projects", "raw", "proposals", "views"]) {
      const keep = path.join(root, d, ".gitkeep");
      if (!(await exists(keep))) await fs.writeFile(keep, "");
    }
    if (!(await isRepo(root))) {
      await git(root, ["init", "--quiet"]);
    }
    await git(root, ["add", "-A"]);
    const staged = await git(root, ["diff", "--cached", "--name-only"]);
    if (staged.trim()) await git(root, ["commit", "--quiet", "-m", "vault: initialize"]);
    return new Vault(root);
  }

  static async open(root: string): Promise<Vault> {
    if (!(await exists(path.join(root, ".keeper")))) {
      throw new Error(`不是 vault（缺少 .keeper/）：${root}。請先執行 substrate init。`);
    }
    return new Vault(root);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** 序列化寫入並提交；fn 回傳被修改的相對路徑。 */
  async write<T>(message: string, fn: () => Promise<{ result: T; paths: string[] }>): Promise<T> {
    const task = this.queue.then(async () => {
      const { result, paths } = await fn();
      await commitPaths(this.root, paths, message);
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  // ---------- memory ----------

  memoryPath(id: string): string {
    return path.join("memory", `${id}.md`);
  }

  async readMemory(id: string): Promise<Memory | null> {
    if (!/^mem_[0-9A-Z]{26}$/.test(id)) return null;
    const text = await readIfExists(path.join(this.root, this.memoryPath(id)));
    if (text === null) return null;
    return parseMemory(text, id);
  }

  async listMemories(): Promise<Memory[]> {
    const files = await listMd(path.join(this.root, "memory"));
    const out: Memory[] = [];
    for (const f of files) {
      const text = await fs.readFile(path.join(this.root, "memory", f), "utf8");
      out.push(parseMemory(text, f));
    }
    return out;
  }

  /** 回傳相對路徑；呼叫端需在 write() 內使用 */
  async saveMemory(mem: Memory): Promise<string> {
    const meta = MemorySchema.parse(mem.meta);
    const rel = this.memoryPath(meta.id);
    await fs.writeFile(path.join(this.root, rel), stringifyFrontmatter(meta, mem.body));
    return rel;
  }

  // ---------- proposals ----------

  proposalPath(id: string): string {
    return path.join("proposals", `${id}.md`);
  }

  async readProposal(id: string): Promise<Proposal | null> {
    if (!/^prop_[0-9A-Z]{26}$/.test(id)) return null;
    const text = await readIfExists(path.join(this.root, this.proposalPath(id)));
    if (text === null) return null;
    return parseProposal(text, id);
  }

  async listProposals(): Promise<Proposal[]> {
    const files = await listMd(path.join(this.root, "proposals"));
    const out: Proposal[] = [];
    for (const f of files) {
      const text = await fs.readFile(path.join(this.root, "proposals", f), "utf8");
      out.push(parseProposal(text, f));
    }
    return out;
  }

  async saveProposal(p: Proposal): Promise<string> {
    const meta = ProposalSchema.parse(p.meta);
    const rel = this.proposalPath(meta.id);
    await fs.writeFile(
      path.join(this.root, rel),
      stringifyFrontmatter(meta, joinThread(p.body, p.thread)),
    );
    return rel;
  }

  // ---------- constitution ----------

  async listConstitution(): Promise<ConstitutionDoc[]> {
    const dir = path.join(this.root, "constitution");
    const files = (await listMd(dir)).filter((f) => f !== "README.md");
    const out: ConstitutionDoc[] = [];
    for (const f of files) {
      const { data, body } = parseFrontmatter(await fs.readFile(path.join(dir, f), "utf8"));
      const d = (data ?? {}) as Record<string, unknown>;
      const disclosure =
        d.disclosure === "card" || d.disclosure === "private" ? d.disclosure : "profile";
      const title =
        typeof d.title === "string" ? d.title : (/^#\s+(.+)$/m.exec(body)?.[1] ?? f.replace(/\.md$/, ""));
      out.push({ file: path.join("constitution", f), title, disclosure, body: body.trim() });
    }
    return out;
  }

  // ---------- raw events ----------

  /** 讀取紀錄（遙測用，不進 git）：用來觀察 agent 是否真的在用記憶 */
  async logAccess(event: RawEvent): Promise<void> {
    const at = this.nowIso();
    const dir = path.join(this.root, ".keeper", "logs");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, `access-${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ at, ...event })}\n`);
  }

  /** 原始事件：append-only，依月份分檔 */
  async appendEvent(event: RawEvent): Promise<string> {
    const at = this.nowIso();
    const rel = path.join("raw", `${at.slice(0, 7)}.jsonl`);
    await fs.appendFile(path.join(this.root, rel), `${JSON.stringify({ at, ...event })}\n`);
    return rel;
  }
}

function parseMemory(text: string, where: string): Memory {
  const { data, body } = parseFrontmatter(text);
  const r = MemorySchema.safeParse(data);
  if (!r.success) throw new Error(`記憶條目格式錯誤（${where}）：${r.error.message}`);
  return { meta: r.data as MemoryMeta, body: body.trim() };
}

function parseProposal(text: string, where: string): Proposal {
  const { data, body } = parseFrontmatter(text);
  const r = ProposalSchema.safeParse(data);
  if (!r.success) throw new Error(`提案格式錯誤（${where}）：${r.error.message}`);
  const split = splitThread(body);
  return { meta: r.data as ProposalMeta, body: split.body, thread: split.thread };
}

async function listMd(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
