import { describe, it, expect } from 'bun:test';
import type { AgentState } from '../types/agent';
import { computeShowSourceBadge, filterAgentsForPresentation, computePartyOrder } from './agentPresentation';

function makeAgent(overrides: Partial<AgentState>): AgentState {
  const base: AgentState = {
    id: 'a1',
    name: 'Hero',
    heroClass: 'warrior',
    heroColor: 'blue',
    status: 'active',
    currentActivity: 'idle',
    tokenUsage: { input: 0, output: 0, cacheRead: 0 },
    cost: 0,
    sessionStart: 0,
    toolCalls: [],
    errors: [],
    filesModified: [],
    lastEvent: 0,
    cwd: '/tmp',
    configDir: '~/.claude',
    source: 'claude',
  } as AgentState;
  return { ...base, ...overrides };
}

describe('filterAgentsForPresentation', () => {
  it('default OFF: active, idle, and waiting pass; completed and error are hidden', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'active1', status: 'active' }),
      makeAgent({ id: 'idle1', status: 'idle' }),
      makeAgent({ id: 'wait1', status: 'waiting' }),
      makeAgent({ id: 'done1', status: 'completed' }),
      makeAgent({ id: 'err1', status: 'error' }),
    ];
    const visible = filterAgentsForPresentation(agents, false);
    expect(visible.map((a) => a.id).sort()).toEqual(['active1', 'idle1', 'wait1']);
  });

  it('toggle ON: active, idle, waiting, and completed all pass', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'active1', status: 'active' }),
      makeAgent({ id: 'idle1', status: 'idle' }),
      makeAgent({ id: 'wait1', status: 'waiting' }),
      makeAgent({ id: 'done1', status: 'completed' }),
    ];
    const visible = filterAgentsForPresentation(agents, true);
    expect(visible.map((a) => a.id).sort()).toEqual(['active1', 'done1', 'idle1', 'wait1']);
  });

  it('toggle ON: error remains hidden', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'err1', status: 'error' }),
      makeAgent({ id: 'done1', status: 'completed' }),
    ];
    const visible = filterAgentsForPresentation(agents, true);
    expect(visible.map((a) => a.id).sort()).toEqual(['done1']);
  });

  it('waiting passes regardless of the completed toggle (regression for turn-end heroes)', () => {
    const agents: AgentState[] = [makeAgent({ id: 'turnend', status: 'waiting' })];
    expect(filterAgentsForPresentation(agents, false).map((a) => a.id)).toEqual(['turnend']);
    expect(filterAgentsForPresentation(agents, true).map((a) => a.id)).toEqual(['turnend']);
  });

  it('preserves all idle and active agents regardless of toggle', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'a', status: 'active' }),
      makeAgent({ id: 'b', status: 'idle' }),
      makeAgent({ id: 'c', status: 'active' }),
    ];
    expect(filterAgentsForPresentation(agents, false).length).toBe(3);
    expect(filterAgentsForPresentation(agents, true).length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(filterAgentsForPresentation([], false)).toEqual([]);
    expect(filterAgentsForPresentation([], true)).toEqual([]);
  });
});

describe('computeShowSourceBadge', () => {
  it('returns false when no agents', () => {
    expect(computeShowSourceBadge([])).toBe(false);
  });

  it('returns false when only one provider has live agents', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'c1', source: 'claude', status: 'active' }),
      makeAgent({ id: 'c2', source: 'claude', status: 'idle' }),
    ];
    expect(computeShowSourceBadge(agents)).toBe(false);
  });

  it('returns true when both providers have at least one live agent', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'c1', source: 'claude', status: 'active' }),
      makeAgent({ id: 'x1', source: 'codex', status: 'idle' }),
    ];
    expect(computeShowSourceBadge(agents)).toBe(true);
  });

  it('ignores completed and error agents when computing liveness', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'c1', source: 'claude', status: 'active' }),
      makeAgent({ id: 'x1', source: 'codex', status: 'completed' }),
      makeAgent({ id: 'x2', source: 'codex', status: 'error' }),
    ];
    expect(computeShowSourceBadge(agents)).toBe(false);
  });

  it('handles a single live codex agent alongside a completed claude agent', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'c1', source: 'claude', status: 'completed' }),
      makeAgent({ id: 'x1', source: 'codex', status: 'active' }),
    ];
    expect(computeShowSourceBadge(agents)).toBe(false);
  });

  it('counts waiting agents as live (consistent with filterAgentsForPresentation)', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'c1', source: 'claude', status: 'waiting' }),
      makeAgent({ id: 'x1', source: 'codex', status: 'active' }),
    ];
    expect(computeShowSourceBadge(agents)).toBe(true);
  });
});

describe('computePartyOrder', () => {
  const labelsById = (agents: AgentState[]) =>
    new Map(computePartyOrder(agents).map((e) => [e.agent.id, e.label]));

  it('returns empty array for empty input', () => {
    expect(computePartyOrder([])).toEqual([]);
  });

  it('numbers a single top-level agent as "1"', () => {
    const labels = labelsById([makeAgent({ id: 'p1' })]);
    expect(labels.get('p1')).toBe('1');
  });

  it('numbers top-level agents 1,2,3 in status order (active before idle)', () => {
    const entries = computePartyOrder([
      makeAgent({ id: 'idle1', status: 'idle' }),
      makeAgent({ id: 'act1', status: 'active' }),
      makeAgent({ id: 'act2', status: 'active' }),
    ]);
    // active agents sort before idle, so they take 1 and 2.
    const labels = new Map(entries.map((e) => [e.agent.id, e.label]));
    expect(labels.get('idle1')).toBe('3');
    expect(new Set([labels.get('act1'), labels.get('act2')])).toEqual(new Set(['1', '2']));
  });

  it('sub-agents inherit the parent number with a letter suffix (1-a, 1-b)', () => {
    const labels = labelsById([
      makeAgent({ id: 'parent', status: 'active' }),
      makeAgent({ id: 'agent-b', status: 'active', isSubagent: true, parentSessionId: 'parent' }),
      makeAgent({ id: 'agent-a', status: 'active', isSubagent: true, parentSessionId: 'parent' }),
    ]);
    expect(labels.get('parent')).toBe('1');
    // Letters follow stable id sort: agent-a -> a, agent-b -> b.
    expect(labels.get('agent-a')).toBe('1-a');
    expect(labels.get('agent-b')).toBe('1-b');
  });

  it('places each parent\'s sub-agents immediately after it', () => {
    const order = computePartyOrder([
      makeAgent({ id: 'p1', status: 'active' }),
      makeAgent({ id: 'p2', status: 'active' }),
      makeAgent({ id: 'agent-s', status: 'active', isSubagent: true, parentSessionId: 'p1' }),
    ]).map((e) => `${e.agent.id}:${e.label}`);
    // p1, then its sub-agent, then p2.
    expect(order).toEqual(['p1:1', 'agent-s:1-a', 'p2:2']);
  });

  it('gives an orphan sub-agent (absent parent) its own backbone number', () => {
    const labels = labelsById([
      makeAgent({ id: 'p1', status: 'active' }),
      makeAgent({ id: 'agent-x', status: 'active', isSubagent: true, parentSessionId: 'missing' }),
    ]);
    expect(labels.get('p1')).toBe('1');
    expect(labels.get('agent-x')).toBe('2');
  });

  it('is deterministic for the same input', () => {
    const agents: AgentState[] = [
      makeAgent({ id: 'parent', status: 'active' }),
      makeAgent({ id: 'agent-a', status: 'active', isSubagent: true, parentSessionId: 'parent' }),
    ];
    expect(computePartyOrder(agents)).toEqual(computePartyOrder(agents));
  });

  it('tags depth 0 for top-level agents and depth 1 for sub-agents', () => {
    const byId = new Map(
      computePartyOrder([
        makeAgent({ id: 'parent', status: 'active' }),
        makeAgent({ id: 'agent-a', status: 'active', isSubagent: true, parentSessionId: 'parent' }),
      ]).map((e) => [e.agent.id, e.depth]),
    );
    expect(byId.get('parent')).toBe(0);
    expect(byId.get('agent-a')).toBe(1);
  });

  it('rolls sibling letters past z (27th sub-agent is "1-aa")', () => {
    const parent = makeAgent({ id: 'parent', status: 'active' });
    // 27 sub-agents with zero-padded ids so lexicographic sort == creation order.
    const subs = Array.from({ length: 27 }, (_, i) =>
      makeAgent({
        id: `agent-${String(i).padStart(2, '0')}`,
        status: 'active',
        isSubagent: true,
        parentSessionId: 'parent',
      }),
    );
    const labels = labelsById([parent, ...subs]);
    expect(labels.get('agent-00')).toBe('1-a');
    expect(labels.get('agent-25')).toBe('1-z');
    expect(labels.get('agent-26')).toBe('1-aa');
  });

  it('never drops a nested grandchild — its parent is a sub-agent, so it gets its own number', () => {
    // parent(top) -> child(sub) -> grandchild(sub whose parent is the child).
    // The grandchild cannot attach (its parent is itself a sub-agent), so it
    // must fall back to the numbered backbone rather than vanish.
    const labels = labelsById([
      makeAgent({ id: 'parent', status: 'active' }),
      makeAgent({ id: 'agent-child', status: 'active', isSubagent: true, parentSessionId: 'parent' }),
      makeAgent({ id: 'agent-grand', status: 'active', isSubagent: true, parentSessionId: 'agent-child' }),
    ]);
    expect(labels.get('parent')).toBe('1');
    expect(labels.get('agent-child')).toBe('1-a');
    // grandchild present (not dropped) with a plain backbone number.
    expect(labels.get('agent-grand')).toBe('2');
  });
});
