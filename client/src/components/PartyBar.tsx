import { useCallback, useEffect, useRef, useState } from 'react';
import { HeroAvatar } from './HeroAvatar';
import { usePartyPrefs } from '../hooks/usePartyPrefs';
import { HERO_LABEL_COLOR, SOURCE_BADGE_COLOR, modelBadge, type AgentState } from '../types/agent';
import { computePartyOrder } from '../presentation/agentPresentation';
import './PartyBar.css';

interface PartyBarProps {
  agents: AgentState[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  showSourceBadge: boolean;
}

const AVATAR_SIZE = 66;
const FLASH_DURATION_MS = 400;

interface PartyRowProps {
  agent: AgentState;
  index: string;
  /** Hierarchy depth (0 = top-level, 1 = sub-agent). Drives the row indent. */
  depth: number;
  mode: 'full' | 'icons';
  isSelected: boolean;
  onClick: () => void;
  showSourceBadge: boolean;
}

function PartyRow({ agent, index, depth, mode, isSelected, onClick, showSourceBadge }: PartyRowProps) {
  const [flashing, setFlashing] = useState(false);
  const prevSelected = useRef(isSelected);

  useEffect(() => {
    if (!prevSelected.current && isSelected) {
      setFlashing(true);
      const id = setTimeout(() => setFlashing(false), FLASH_DURATION_MS);
      prevSelected.current = isSelected;
      return () => clearTimeout(id);
    }
    prevSelected.current = isSelected;
  }, [isSelected]);

  const classes = [
    'partybar-agent',
    `mode-${mode}`,
    isSelected ? 'selected' : '',
    flashing ? 'flashing' : '',
    depth > 0 ? 'subrow' : '',
  ].filter(Boolean).join(' ');

  const title = mode === 'icons'
    ? `${agent.name} · ${agent.currentActivity}`
    : undefined;

  // Sub-agents render smaller than top-level sessions, here and in the village.
  const avatarSize = depth > 0 ? Math.round(AVATAR_SIZE * 0.7) : AVATAR_SIZE;

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      aria-label={`Select ${agent.name}${showSourceBadge ? ` (${agent.source})` : ''}, ${agent.currentActivity}`}
      aria-current={isSelected ? 'true' : undefined}
      title={title}
    >
      <span className="partybar-avatar-wrap">
        <span className="partybar-index" aria-label={`hero ${index}`}>{index}</span>
        <HeroAvatar agent={agent} size={avatarSize} />
        <span className={`partybar-status-overlay ${agent.status}`} aria-hidden="true" />
      </span>
      {mode === 'full' && (
        <span className="partybar-row-body">
          <span className="partybar-row-top">
            <span
              className="partybar-agent-name"
              style={isSelected ? undefined : { color: HERO_LABEL_COLOR[agent.heroColor] }}
            >{agent.name}</span>
            <span className={`partybar-dot ${agent.status}`} aria-hidden="true" />
          </span>
          <span className="partybar-row-bottom">
            <span className="partybar-activity">{agent.currentActivity}</span>
            {showSourceBadge && (
              <span
                className="partybar-source-badge"
                style={{
                  color: SOURCE_BADGE_COLOR[agent.source],
                  borderColor: `${SOURCE_BADGE_COLOR[agent.source]}80`,
                  background: `${SOURCE_BADGE_COLOR[agent.source]}14`,
                }}
                aria-label={`source ${agent.source}`}
              >
                {agent.source.toUpperCase()}
              </span>
            )}
            {(() => {
              const badge = modelBadge(agent.model);
              if (badge === null) return null;
              return (
                <span
                  className="partybar-model-badge"
                  style={{
                    color: badge.color,
                    borderColor: `${badge.color}80`,
                    background: `${badge.color}14`,
                  }}
                  aria-label={`model ${agent.model ?? ''}`}
                  title={agent.model}
                >
                  {badge.short}
                </span>
              );
            })()}
          </span>
        </span>
      )}
    </button>
  );
}

export function PartyBar({ agents, selectedAgentId, onSelectAgent, showSourceBadge }: PartyBarProps) {
  const [prefs, updatePrefs] = usePartyPrefs();
  const mode: 'full' | 'icons' = prefs.foldState;

  // `agents` is the App-level presentation projection: `active` / `idle` /
  // `waiting` always pass, `completed` only when the TopBar toggle is on, and
  // `error` is filtered out. computePartyOrder status-sorts the backbone (active
  // first) and groups each parent's sub-agents right after it with "1-a" labels.
  const entries = computePartyOrder(agents);
  const activeCount = agents.filter((a) => a.status === 'active').length;
  const idleCount = agents.filter((a) => a.status === 'idle').length;
  const completedCount = agents.filter((a) => a.status === 'completed').length;

  const toggleFold = useCallback(() => {
    updatePrefs({ foldState: mode === 'full' ? 'icons' : 'full' });
  }, [mode, updatePrefs]);

  const handleClick = useCallback((id: string) => {
    onSelectAgent(id);
  }, [onSelectAgent]);

  return (
    <div className={`partybar mode-${mode}`} role="list" aria-label="Party">
      <div className="partybar-header">
        {mode === 'full' ? (
          <span className="partybar-title">
            Party ({activeCount} active, {idleCount} idle
            {completedCount > 0 ? `, ${completedCount} done` : ''})
          </span>
        ) : (
          <span className="partybar-title-compact">{entries.length}</span>
        )}
        <button
          type="button"
          className="partybar-fold-btn"
          aria-label={mode === 'full' ? 'Collapse to icons' : 'Expand party'}
          aria-pressed={mode === 'icons'}
          onClick={toggleFold}
        >{mode === 'full' ? '◀' : '▶'}</button>
      </div>

      <div className="partybar-list">
        {entries.map(({ agent, label, depth }) => (
          <PartyRow
            key={agent.id}
            agent={agent}
            index={label}
            depth={depth}
            mode={mode}
            isSelected={agent.id === selectedAgentId}
            onClick={() => handleClick(agent.id)}
            showSourceBadge={showSourceBadge}
          />
        ))}
      </div>
    </div>
  );
}
