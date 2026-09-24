import YAML from "yaml";
import type { Role, ThreadEntry } from "./types.js";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(text: string): { data: unknown; body: string } {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: YAML.parse(m[1]) ?? {}, body: m[2] };
}

export function stringifyFrontmatter(data: object, body: string): string {
  const yaml = YAML.stringify(stripUndefined(data), { lineWidth: 0 }).trimEnd();
  const trimmed = body.replace(/^\n+/, "").trimEnd();
  return `---\n${yaml}\n---\n${trimmed ? `\n${trimmed}\n` : ""}`;
}

function stripUndefined(obj: object): object {
  return JSON.parse(JSON.stringify(obj));
}

const THREAD_HEADING = "## Thread";
const ENTRY_RE = /^### (\S+) · (.+) \((agent|keeper|user)\)$/;

/** 提案本文與討論串以 `## Thread` 分隔；討論串只追加，不改寫。 */
export function splitThread(body: string): { body: string; thread: ThreadEntry[] } {
  const idx = body.search(/^## Thread\s*$/m);
  if (idx < 0) return { body: body.trim(), thread: [] };
  const main = body.slice(0, idx).trim();
  const lines = body.slice(idx).split(/\r?\n/).slice(1);
  const thread: ThreadEntry[] = [];
  let cur: ThreadEntry | null = null;
  for (const line of lines) {
    const m = ENTRY_RE.exec(line);
    if (m) {
      if (cur) thread.push(finish(cur));
      cur = { at: m[1], author: m[2], role: m[3] as Role, text: "" };
    } else if (cur) {
      cur.text += `${line}\n`;
    }
  }
  if (cur) thread.push(finish(cur));
  return { body: main, thread };
}

function finish(e: ThreadEntry): ThreadEntry {
  return { ...e, text: e.text.trim() };
}

export function joinThread(body: string, thread: ThreadEntry[]): string {
  const parts = [body.trim()];
  parts.push(THREAD_HEADING);
  for (const e of thread) {
    parts.push(`### ${e.at} · ${e.author} (${e.role})\n\n${e.text.trim()}`);
  }
  return parts.filter(Boolean).join("\n\n");
}
