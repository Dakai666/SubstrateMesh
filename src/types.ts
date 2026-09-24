import { z } from "zod";

export const LAYERS = ["constitution", "preference", "experience"] as const;
export const KINDS = [
  "preference",
  "fact",
  "principle",
  "lesson",
  "example",
  "focus",
  "calibration",
] as const;
/** stated = 使用者親口說的；observed = 由行為觀察；inferred = agent 的推測 */
export const VOICES = ["stated", "observed", "inferred"] as const;
/** card = 名片；profile = 畫像；private = 自傳／私密 */
export const DISCLOSURES = ["card", "profile", "private"] as const;
export const MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
export const PROPOSAL_STATUSES = [
  "pending",
  "merged",
  "rejected",
  "deferred",
  "escalated",
] as const;
export const PROPOSAL_ACTIONS = ["create", "update", "supersede", "archive"] as const;
export const ROLES = ["agent", "keeper", "user"] as const;

export type Layer = (typeof LAYERS)[number];
export type Kind = (typeof KINDS)[number];
export type Voice = (typeof VOICES)[number];
export type Disclosure = (typeof DISCLOSURES)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type Role = (typeof ROLES)[number];

export const ScopeSchema = z.object({
  domain: z.string().optional(),
  contexts: z.array(z.string()).default([]),
  /** 適用哪些 agent；"*" 代表全部 */
  agents: z.array(z.string()).default(["*"]),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const EvidenceSchema = z.object({
  proposal: z.string().optional(),
  source: z.string(),
  quote: z.string().optional(),
  at: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const MemorySchema = z.object({
  id: z.string().regex(/^mem_[0-9A-Z]{26}$/),
  layer: z.enum(LAYERS),
  kind: z.enum(KINDS),
  voice: z.enum(VOICES),
  claim: z.string().min(1),
  scope: ScopeSchema.default({ contexts: [], agents: ["*"] }),
  disclosure: z.enum(DISCLOSURES).default("profile"),
  confidence: z.number().min(0).max(1),
  status: z.enum(MEMORY_STATUSES).default("active"),
  valid_from: z.string(),
  valid_until: z.string().nullable().default(null),
  /** 例如 "30d"、"12h"；從 valid_from 起算 */
  ttl: z.string().regex(/^\d+[hdw]$/).nullable().default(null),
  supersedes: z.array(z.string()).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MemoryMeta = z.infer<typeof MemorySchema>;
export interface Memory {
  meta: MemoryMeta;
  body: string;
}

export const ResolutionSchema = z.object({
  by: z.string(),
  role: z.enum(ROLES),
  at: z.string(),
  note: z.string().optional(),
  memory: z.string().optional(),
});

export const ProposalSchema = z.object({
  id: z.string().regex(/^prop_[0-9A-Z]{26}$/),
  status: z.enum(PROPOSAL_STATUSES),
  proposer: z.string(),
  submitted_at: z.string(),
  action: z.enum(PROPOSAL_ACTIONS),
  target: z.string().nullable().default(null),
  claim: z.string().min(1),
  kind: z.enum(KINDS),
  voice: z.enum(VOICES),
  suggested_layer: z.enum(LAYERS),
  scope: ScopeSchema.default({ contexts: [], agents: ["*"] }),
  disclosure: z.enum(DISCLOSURES).default("profile"),
  confidence: z.number().min(0).max(1),
  ttl: z.string().regex(/^\d+[hdw]$/).nullable().default(null),
  evidence: z.array(EvidenceSchema).default([]),
  /** 提交者的觀點與推論理由——agent 的聲音記錄於此 */
  rationale: z.string().default(""),
  resolution: ResolutionSchema.nullable().default(null),
});
export type ProposalMeta = z.infer<typeof ProposalSchema>;
export interface Proposal {
  meta: ProposalMeta;
  /** 補充內容（例如優秀範例的全文），不含討論串 */
  body: string;
  thread: ThreadEntry[];
}
export interface ThreadEntry {
  at: string;
  author: string;
  role: Role;
  text: string;
}

/** 呼叫者身分：由 transport 層決定，而非由 agent 自報 */
export interface Actor {
  name: string;
  role: Role;
  clearance: Disclosure;
}

export const DISCLOSURE_RANK: Record<Disclosure, number> = {
  card: 0,
  profile: 1,
  private: 2,
};
