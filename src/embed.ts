import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * 語意檢索的向量來源。只接本機模型；未設定或連不上時，呼叫端一律退回純 BM25。
 */
export interface Embedder {
  /** 模型識別；改變時快取整批失效 */
  readonly model: string;
  /** query 與 document 分開：部分模型（例如 qwen3-embedding）只在查詢端加指令前綴 */
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

export interface SemanticOptions {
  /** 混合權重：BM25 佔 alpha，語意佔 1 - alpha */
  alpha: number;
  /** cosine 絕對下限：低於此值的語意相似度視為無關 */
  minCosine: number;
}

export const DEFAULT_SEMANTIC: SemanticOptions = { alpha: 0.5, minCosine: 0.4 };

/** 已知模型的查詢端前綴；未列出的模型不加 */
const QUERY_PREFIX: Array<[RegExp, string]> = [
  [
    /qwen3-embedding/i,
    "Instruct: Given a search query, retrieve memories about the user that are relevant to the query\nQuery: ",
  ],
];

export interface HttpEmbedderOptions {
  /** Ollama 根網址（例如 http://127.0.0.1:11434），或 OpenAI 相容的 .../v1/embeddings 完整網址 */
  url: string;
  model: string;
  queryPrefix?: string;
  timeoutMs?: number;
}

export class HttpEmbedder implements Embedder {
  readonly model: string;
  private readonly queryPrefix: string;
  private readonly openai: boolean;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpEmbedderOptions) {
    this.model = opts.model;
    this.queryPrefix = opts.queryPrefix ?? QUERY_PREFIX.find(([re]) => re.test(opts.model))?.[1] ?? "";
    const url = opts.url.trim().replace(/\/+$/, "");
    this.openai = /\/embeddings$/.test(url);
    this.endpoint = this.openai ? url : `${url}/api/embed`;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    if (!texts.length) return [];
    const input = kind === "query" ? texts.map((t) => this.queryPrefix + t) : texts;
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`embedding 端點回應 ${res.status}`);
    const json = (await res.json()) as { embeddings?: number[][]; data?: { embedding: number[] }[] };
    const out = this.openai ? json.data?.map((d) => d.embedding) : json.embeddings;
    if (!out || out.length !== texts.length) throw new Error("embedding 端點回傳的向量數量不符");
    return out;
  }
}

/**
 * 由環境變數建立 embedder 與混合參數；未設定 SUBSTRATE_EMBED_URL 則不啟用。
 *   SUBSTRATE_EMBED_URL          例如 http://127.0.0.1:11434
 *   SUBSTRATE_EMBED_MODEL        例如 qwen3-embedding:0.6b
 *   SUBSTRATE_EMBED_ALPHA        BM25 權重，預設 0.5
 *   SUBSTRATE_EMBED_MIN_COSINE   cosine 絕對下限，預設 0.4（依模型校準）
 *   SUBSTRATE_EMBED_QUERY_PREFIX 覆寫查詢端前綴
 */
export function semanticFromEnv(
  env: NodeJS.ProcessEnv,
): { embedder: Embedder; options: SemanticOptions } | null {
  const url = env.SUBSTRATE_EMBED_URL?.trim();
  const model = env.SUBSTRATE_EMBED_MODEL?.trim();
  if (!url || !model) return null;
  const num = (v: string | undefined, fallback: number) => {
    const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    embedder: new HttpEmbedder({ url, model, queryPrefix: env.SUBSTRATE_EMBED_QUERY_PREFIX }),
    options: {
      alpha: Math.min(1, Math.max(0, num(env.SUBSTRATE_EMBED_ALPHA, DEFAULT_SEMANTIC.alpha))),
      minCosine: num(env.SUBSTRATE_EMBED_MIN_COSINE, DEFAULT_SEMANTIC.minCosine),
    },
  };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

interface CacheFile {
  model: string;
  vectors: Record<string, string>;
}

/** 連不上時暫停嘗試的時間，避免每次查詢都卡在逾時 */
const RETRY_AFTER_MS = 60_000;
/** 單次送給 embedding 端點的文件數；依模型的輸入上限與速度可調 */
const BATCH = 32;

/**
 * 語意索引：文件向量以內容 hash 快取，只重算有變動的條目；模型改變時整批失效。
 * 快取存於 vault 的 .index/（自帶 .gitignore，不進版本控制）。向量是個資的摘要，
 * 不經任何 MCP 工具對外暴露。
 */
export class SemanticIndex {
  private loaded: CacheFile | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private downUntil = 0;

  constructor(
    private readonly dir: string,
    readonly embedder: Embedder,
    readonly options: SemanticOptions = DEFAULT_SEMANTIC,
  ) {}

  private get file() {
    return path.join(this.dir, "embeddings.json");
  }

  /**
   * query 對每段文字的 cosine；embedder 失效時回傳 null（呼叫端退回純 BM25）。
   * corpus 必須是完整語料（與呼叫者權限無關），快取才能安全地清掉已消失的條目。
   */
  async similarities(corpus: string[], query: string): Promise<number[] | null> {
    return this.guard(async () => {
      const [docs, q] = await Promise.all([this.documents(corpus), this.embedder.embed([query], "query")]);
      const qv = Float32Array.from(q[0]!);
      return docs.map((d) => cosine(qv, d));
    });
  }

  /** 語料的文件向量（同樣走快取；corpus 的要求同 similarities） */
  vectors(corpus: string[]): Promise<Float32Array[] | null> {
    return this.guard(() => this.documents(corpus));
  }

  /** 不進快取的一次性向量，例如標籤 */
  adhoc(texts: string[]): Promise<Float32Array[] | null> {
    return this.guard(async () => (await this.embedder.embed(texts, "document")).map((v) => Float32Array.from(v)));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | null> {
    if (Date.now() < this.downUntil) return null;
    try {
      return await fn();
    } catch (err) {
      this.downUntil = Date.now() + RETRY_AFTER_MS;
      console.error(`語意檢索暫停 ${RETRY_AFTER_MS / 1000} 秒，改用純 BM25：${(err as Error).message}`);
      return null;
    }
  }

  private async load(): Promise<CacheFile> {
    if (this.loaded?.model === this.embedder.model) return this.loaded;
    let data: CacheFile = { model: this.embedder.model, vectors: {} };
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as CacheFile;
      if (parsed.model === this.embedder.model && parsed.vectors) data = parsed;
    } catch {
      // 沒有快取或格式損壞：重建即可
    }
    this.loaded = data;
    return data;
  }

  /** 序列化執行，避免併發請求重複補算或同時寫檔 */
  private documents(texts: string[]): Promise<Float32Array[]> {
    const run = this.pending.then(async () => {
      const cache = await this.load();
      const keys = texts.map(hash);
      const missing = [...new Set(keys.filter((k) => !(k in cache.vectors)))];
      const byKey = new Map(keys.map((k, i) => [k, texts[i]!]));
      // 分批補算並逐批落地：冷啟動時大量條目不會卡在單一請求的逾時，失敗也保留已算好的部分
      for (let i = 0; i < missing.length; i += BATCH) {
        const chunk = missing.slice(i, i + BATCH);
        const vecs = await this.embedder.embed(
          chunk.map((k) => byKey.get(k)!),
          "document",
        );
        chunk.forEach((k, j) => (cache.vectors[k] = encode(vecs[j]!)));
        await this.save(cache);
      }
      const live = new Set(keys);
      const stale = Object.keys(cache.vectors).filter((k) => !live.has(k));
      for (const k of stale) delete cache.vectors[k];
      if (stale.length) await this.save(cache);
      return keys.map((k) => decode(cache.vectors[k]!));
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async save(cache: CacheFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, ".gitignore"), "*\n");
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}

function encode(v: number[]): string {
  return Buffer.from(Float32Array.from(v).buffer).toString("base64");
}

function decode(s: string): Float32Array {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
