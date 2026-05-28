import type { AgentState } from '../types/agent';

/**
 * Project the full `agents` snapshot to the subset displayed in the Party
 * Bar and the Phaser village scene. TopBar stats and DetailPanel lookup
 * keep using the unfiltered list — this projection only governs the two
 * presentation surfaces.
 *
 * This function is the single authoritative gate for which statuses reach
 * those surfaces:
 *
 *   - `active`, `idle`, `waiting` — always pass through. `waiting` is a
 *     short-lived "turn just ended, hero is resting at the tavern" state;
 *     HeroSprite has dedicated pulse/label rendering for it, so it must
 *     reach the Phaser scene. computeShowSourceBadge treats waiting as
 *     live too — keep the two functions in agreement.
 *   - `completed` — pass through only when `showCompleted` is true.
 *   - `error` — always blocked here. The scene additionally drops `error`
 *     defensively, and there is currently no Party Bar surfacing for it.
 *
 * Downstream consumers may apply additional local hiding (e.g. the Phaser
 * scene drops heroes whose last event is older than its idle threshold),
 * but they MUST NOT re-introduce `error` once it has been filtered out.
 */
export function filterAgentsForPresentation(
  agents: AgentState[],
  showCompleted: boolean,
): AgentState[] {
  return agents.filter((agent) => {
    if (agent.status === 'active' || agent.status === 'idle' || agent.status === 'waiting') {
      return true;
    }
    if (agent.status === 'completed' && showCompleted) return true;
    return false;
  });
}

/**
 * Whether the source-provider badge (Claude/Codex orange/teal pill) should
 * be shown anywhere in the UI. Only true when both providers have at least
 * one LIVE agent — completed/error sessions don't count, otherwise the
 * badge would linger after the last Codex hero finishes.
 *
 * Used by both App.tsx (React overlays) and VillageScene.ts (Phaser sprite
 * badges); keep them in sync by calling this function instead of inlining
 * the logic.
 */
export function computeShowSourceBadge(agents: AgentState[]): boolean {
  let hasClaude = false;
  let hasCodex = false;
  for (const a of agents) {
    if (a.status === 'completed' || a.status === 'error') continue;
    if (a.source === 'claude') hasClaude = true;
    else if (a.source === 'codex') hasCodex = true;
    if (hasClaude && hasCodex) return true;
  }
  return false;
}

const PARTY_STATUS_ORDER: Record<AgentState['status'], number> = {
  active: 0,
  waiting: 1,
  idle: 2,
  error: 3,
  completed: 4,
};

export interface PartyEntry {
  agent: AgentState;
  /**
   * Display label. Top-level agents get a plain number ("1", "2", …).
   * A sub-agent inherits its parent's number with a letter suffix
   * ("1-a", "1-b", …) — that shared number is the only cue that ties it to
   * its parent (no connector line, no forced clustering).
   */
  label: string;
}

/** 0 -> "a", 1 -> "b", … 25 -> "z", 26 -> "aa". */
function siblingLetter(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(97 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * Order and label agents for the Party Bar, the hero index marker, and the
 * Activity Feed so all three surfaces agree.
 *
 * Top-level agents (and orphan sub-agents whose parent isn't in this list) form
 * the numbered backbone, status-sorted and numbered 1, 2, 3…. Each parent's
 * present sub-agents are grouped immediately after it and labelled
 * `<parentNumber>-<letter>` in stable id order (1-a, 1-b, …).
 */
export function computePartyOrder(agents: AgentState[]): PartyEntry[] {
  const presentIds = new Set(agents.map((a) => a.id));
  const isAttachedSub = (a: AgentState): boolean =>
    a.isSubagent && a.parentSessionId !== undefined && presentIds.has(a.parentSessionId);

  const backbone = agents
    .filter((a) => !isAttachedSub(a))
    .sort((x, y) => PARTY_STATUS_ORDER[x.status] - PARTY_STATUS_ORDER[y.status]);

  const childrenByParent = new Map<string, AgentState[]>();
  for (const a of agents) {
    if (!isAttachedSub(a)) continue;
    const parentId = a.parentSessionId as string;
    const list = childrenByParent.get(parentId);
    if (list === undefined) childrenByParent.set(parentId, [a]);
    else list.push(a);
  }
  for (const list of childrenByParent.values()) {
    list.sort((x, y) => x.id.localeCompare(y.id));
  }

  const entries: PartyEntry[] = [];
  backbone.forEach((parent, i) => {
    const num = String(i + 1);
    entries.push({ agent: parent, label: num });
    const kids = childrenByParent.get(parent.id);
    if (kids !== undefined) {
      kids.forEach((kid, k) => {
        entries.push({ agent: kid, label: `${num}-${siblingLetter(k)}` });
      });
    }
  });
  return entries;
}
