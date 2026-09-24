import { newMemoryId, newProposalId, type Vault } from "./vault.js";
import {
  type Actor,
  type Disclosure,
  type Evidence,
  type Kind,
  type Layer,
  type Memory,
  type Proposal,
  type ProposalMeta,
  type Scope,
  type ThreadEntry,
  type Voice,
} from "./types.js";
import { isExpired } from "./context.js";

export class PolicyError extends Error {}

export interface SubmitInput {
  claim: string;
  kind: Kind;
  voice: Voice;
  suggested_layer: Layer;
  action?: "create" | "update" | "supersede" | "archive";
  target?: string | null;
  scope?: Partial<Scope>;
  disclosure?: Disclosure;
  confidence: number;
  ttl?: string | null;
  evidence?: Partial<Evidence>[];
  rationale?: string;
  body?: string;
  session?: string;
}

export interface SubmitResult {
  proposal: string;
  notes: string[];
}

const normalize = (s: string) => s.replace(/\s+/g, "").replace(/[。．.！!？?，,、；;：:「」『』"'`]/g, "").toLowerCase();

/** 硬性不變式——無論 policy.yaml 怎麼設定，程式都會強制執行。 */
function assertLayerAllowed(voice: Voice, layer: Layer) {
  if (voice === "inferred" && layer === "constitution") {
    throw new PolicyError("推測（inferred）永遠不能進入憲法層。");
  }
}

export async function submitProposal(
  vault: Vault,
  actor: Actor,
  input: SubmitInput,
): Promise<SubmitResult> {
  assertLayerAllowed(input.voice, input.suggested_layer);
  const now = vault.nowIso();
  let action = input.action ?? "create";
  let target = input.target ?? null;
  const notes: string[] = [];
  const thread: ThreadEntry[] = [];

  if (action !== "create") {
    if (!target) throw new PolicyError(`action=${action} 需要指定 target（mem_...）。`);
    const mem = await vault.readMemory(target);
    if (!mem) throw new PolicyError(`找不到 target：${target}`);
  }

  const evidence: Evidence[] = (input.evidence ?? []).map((e) => ({
    source: e.source ?? (input.session ? `${actor.name}/${input.session}` : actor.name),
    quote: e.quote,
    at: e.at ?? now,
  }));
  if (evidence.length === 0 || evidence.every((e) => !e.quote)) {
    notes.push("此提案沒有附上使用者原話，Keeper 審查時會降低權重。");
  }

  const key = normalize(input.claim);
  const [memories, proposals] = await Promise.all([vault.listMemories(), vault.listProposals()]);

  // 與進行中的提案相同 → 視為獨立佐證，併入既有提案
  const open = proposals.find(
    (p) =>
      ["pending", "deferred", "escalated"].includes(p.meta.status) &&
      normalize(p.meta.claim) === key &&
      p.meta.action === action &&
      p.meta.target === target,
  );
  if (open) {
    return vault.write(`proposal: corroborate ${open.meta.id} by ${actor.name}`, async () => {
      open.meta.evidence.push(...evidence);
      open.thread.push({
        at: now,
        author: actor.name,
        role: actor.role,
        text: `補充佐證${input.session ? `（session ${input.session}）` : ""}。${input.rationale ?? ""}`.trim(),
      });
      const rel = await vault.saveProposal(open);
      const raw = await vault.appendEvent({
        type: "proposal.corroborated",
        actor: actor.name,
        session: input.session,
        proposal: open.meta.id,
      });
      return {
        result: {
          proposal: open.meta.id,
          notes: [...notes, `已有相同的待審提案 ${open.meta.id}，本次內容已併入作為佐證。`],
        },
        paths: [rel, raw],
      };
    });
  }

  // 與既有知識相同 → 轉為強化（update）
  if (action === "create") {
    const known = memories.find(
      (m) => m.meta.status === "active" && normalize(m.meta.claim) === key,
    );
    if (known) {
      action = "update";
      target = known.meta.id;
      notes.push(`已存在相同的知識 ${known.meta.id}，本提案轉為強化佐證（update）。`);
      thread.push({ at: now, author: "substrate", role: "keeper", text: `自動轉為對 ${known.meta.id} 的強化佐證。` });
    }
  }

  const rejected = proposals.find((p) => p.meta.status === "rejected" && normalize(p.meta.claim) === key);
  if (rejected) {
    const reason = rejected.meta.resolution?.note ?? "（未註明）";
    notes.push(`注意：相同主張曾被拒絕（${rejected.meta.id}）：${reason}`);
    thread.push({
      at: now,
      author: "substrate",
      role: "keeper",
      text: `相同主張曾於 ${rejected.meta.id} 被拒絕，理由：${reason}`,
    });
  }

  const meta: ProposalMeta = {
    id: newProposalId(),
    status: "pending",
    proposer: actor.name,
    submitted_at: now,
    action,
    target,
    claim: input.claim.trim(),
    kind: input.kind,
    voice: input.voice,
    suggested_layer: input.suggested_layer,
    scope: {
      domain: input.scope?.domain,
      contexts: input.scope?.contexts ?? [],
      agents: input.scope?.agents?.length ? input.scope.agents : ["*"],
    },
    disclosure: input.disclosure ?? "profile",
    confidence: input.confidence,
    ttl: input.ttl ?? null,
    evidence,
    rationale: input.rationale ?? "",
    resolution: null,
  };
  const proposal: Proposal = { meta, body: input.body ?? "", thread };

  return vault.write(`proposal: submit ${meta.id} by ${actor.name}`, async () => {
    const rel = await vault.saveProposal(proposal);
    const raw = await vault.appendEvent({
      type: "proposal.submitted",
      actor: actor.name,
      session: input.session,
      proposal: meta.id,
      evidence: evidence.map((e) => e.quote).filter(Boolean),
    });
    return { result: { proposal: meta.id, notes }, paths: [rel, raw] };
  });
}

// ---------------- 審查 ----------------

export interface MergeOverrides {
  layer?: Layer;
  kind?: Kind;
  claim?: string;
  confidence?: number;
  scope?: Partial<Scope>;
  disclosure?: Disclosure;
  ttl?: string | null;
}

const REVIEWABLE = ["pending", "deferred", "escalated"];

async function loadReviewable(vault: Vault, actor: Actor, id: string): Promise<Proposal> {
  if (actor.role === "agent") throw new PolicyError("只有 Keeper 或使用者可以審查提案。");
  const p = await vault.readProposal(id);
  if (!p) throw new PolicyError(`找不到提案：${id}`);
  if (!REVIEWABLE.includes(p.meta.status)) {
    throw new PolicyError(`提案 ${id} 已是 ${p.meta.status}，無法再審查。`);
  }
  return p;
}

export async function mergeProposal(
  vault: Vault,
  actor: Actor,
  id: string,
  note?: string,
  overrides: MergeOverrides = {},
): Promise<{ memory: string }> {
  const p = await loadReviewable(vault, actor, id);
  const m = p.meta;

  if (actor.role === "keeper" && m.proposer === actor.name) {
    throw new PolicyError("職責分離：Keeper 不能合併自己提交的提案，需由使用者裁決。");
  }
  const layer = overrides.layer ?? m.suggested_layer;
  assertLayerAllowed(m.voice, layer);

  const target = m.target ? await vault.readMemory(m.target) : null;
  if (m.target && !target) throw new PolicyError(`找不到 target：${m.target}`);
  const touchesConstitution = layer === "constitution" || target?.meta.layer === "constitution";
  if (touchesConstitution && actor.role !== "user") {
    throw new PolicyError("觸及憲法層的提案只能由使用者合併；請改用 escalate。");
  }

  const now = vault.nowIso();
  const evidence: Evidence[] = m.evidence.map((e) => ({ ...e, proposal: m.id }));
  const scope = {
    domain: overrides.scope?.domain ?? m.scope.domain,
    contexts: overrides.scope?.contexts ?? m.scope.contexts,
    agents: overrides.scope?.agents ?? m.scope.agents,
  };
  const paths: string[] = [];

  return vault.write(`proposal: merge ${m.id} by ${actor.name}`, async () => {
    let memoryId: string;
    const fresh = (supersedes: string[]): Memory => ({
      meta: {
        id: newMemoryId(),
        layer,
        kind: overrides.kind ?? m.kind,
        voice: m.voice,
        claim: overrides.claim ?? m.claim,
        scope,
        disclosure: overrides.disclosure ?? m.disclosure,
        confidence: overrides.confidence ?? m.confidence,
        status: "active",
        valid_from: now,
        valid_until: null,
        ttl: overrides.ttl !== undefined ? overrides.ttl : m.ttl,
        supersedes,
        evidence,
        created_at: now,
        updated_at: now,
      },
      body: p.body,
    });

    if (m.action === "create") {
      const mem = fresh([]);
      paths.push(await vault.saveMemory(mem));
      memoryId = mem.meta.id;
    } else if (m.action === "update") {
      const t = target!;
      t.meta.claim = overrides.claim ?? m.claim;
      t.meta.confidence = overrides.confidence ?? Math.max(t.meta.confidence, m.confidence);
      t.meta.evidence.push(...evidence);
      if (overrides.layer) t.meta.layer = overrides.layer;
      if (overrides.kind) t.meta.kind = overrides.kind;
      if (overrides.scope) t.meta.scope = scope;
      if (overrides.disclosure) t.meta.disclosure = overrides.disclosure;
      if (overrides.ttl !== undefined) t.meta.ttl = overrides.ttl;
      // 使用者親口確認過的，口吻升級為 stated
      if (m.voice === "stated") t.meta.voice = "stated";
      t.meta.updated_at = now;
      if (p.body) t.body = p.body;
      paths.push(await vault.saveMemory(t));
      memoryId = t.meta.id;
    } else if (m.action === "supersede") {
      const t = target!;
      t.meta.status = "superseded";
      t.meta.valid_until = now;
      t.meta.updated_at = now;
      paths.push(await vault.saveMemory(t));
      const mem = fresh([t.meta.id]);
      paths.push(await vault.saveMemory(mem));
      memoryId = mem.meta.id;
    } else {
      const t = target!;
      t.meta.status = "archived";
      t.meta.valid_until = now;
      t.meta.updated_at = now;
      t.meta.evidence.push(...evidence);
      paths.push(await vault.saveMemory(t));
      memoryId = t.meta.id;
    }

    m.status = "merged";
    m.resolution = { by: actor.name, role: actor.role, at: now, note, memory: memoryId };
    if (note) p.thread.push({ at: now, author: actor.name, role: actor.role, text: `合併：${note}` });
    paths.push(await vault.saveProposal(p));
    paths.push(
      await vault.appendEvent({ type: "proposal.merged", actor: actor.name, proposal: m.id, memory: memoryId }),
    );
    return { result: { memory: memoryId }, paths };
  });
}

type Transition = "rejected" | "deferred" | "escalated";

export async function transitionProposal(
  vault: Vault,
  actor: Actor,
  id: string,
  to: Transition,
  note: string,
): Promise<void> {
  if (!note.trim()) throw new PolicyError(`${to} 需要附上理由或問題。`);
  const p = await loadReviewable(vault, actor, id);
  const now = vault.nowIso();
  const label = { rejected: "拒絕", deferred: "延後", escalated: "上呈使用者" }[to];
  await vault.write(`proposal: ${to} ${id} by ${actor.name}`, async () => {
    p.meta.status = to;
    if (to === "rejected") p.meta.resolution = { by: actor.name, role: actor.role, at: now, note };
    p.thread.push({ at: now, author: actor.name, role: actor.role, text: `${label}：${note}` });
    const rel = await vault.saveProposal(p);
    const raw = await vault.appendEvent({ type: `proposal.${to}`, actor: actor.name, proposal: id, note });
    return { result: undefined, paths: [rel, raw] };
  });
}

export async function commentProposal(vault: Vault, actor: Actor, id: string, text: string): Promise<void> {
  if (actor.role === "agent") throw new PolicyError("只有 Keeper 或使用者可以在討論串留言。");
  const p = await vault.readProposal(id);
  if (!p) throw new PolicyError(`找不到提案：${id}`);
  await vault.write(`proposal: comment ${id} by ${actor.name}`, async () => {
    p.thread.push({ at: vault.nowIso(), author: actor.name, role: actor.role, text });
    return { result: undefined, paths: [await vault.saveProposal(p)] };
  });
}

/** 代謝：把 TTL 到期的知識封存（不刪除）。 */
export async function expireMemories(vault: Vault, actor: Actor): Promise<string[]> {
  if (actor.role === "agent") throw new PolicyError("只有 Keeper 或使用者可以執行代謝。");
  const now = vault.now();
  const expired = (await vault.listMemories()).filter(
    (m) => m.meta.status === "active" && isExpired(m.meta, now),
  );
  if (expired.length === 0) return [];
  return vault.write(`keeper: expire ${expired.length} memories`, async () => {
    const paths: string[] = [];
    for (const m of expired) {
      m.meta.status = "archived";
      m.meta.valid_until = now.toISOString();
      m.meta.updated_at = now.toISOString();
      paths.push(await vault.saveMemory(m));
    }
    paths.push(
      await vault.appendEvent({ type: "memory.expired", actor: actor.name, memories: expired.map((m) => m.meta.id) }),
    );
    return { result: expired.map((m) => m.meta.id), paths };
  });
}

