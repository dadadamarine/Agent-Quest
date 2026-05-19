import type { ServerWebSocket } from 'bun';
import type { WsEvent, AgentState } from '../types';

export type WsClient = ServerWebSocket<{ id: string }>;

// Warn when a single broadcast frame crosses this size — historically the
// snapshot grew large enough (multi-MB) to make the browser drop the WS on
// connect (issue #7). Keeps an eye on regressions without flooding the log.
const LARGE_MESSAGE_WARN_BYTES = 500 * 1024;

export class WebSocketServer {
  private clients = new Set<WsClient>();

  handleOpen(ws: WsClient): void {
    this.clients.add(ws);
    console.log(`[WS] client connected (total: ${this.clients.size})`);
  }

  handleClose(ws: WsClient, code?: number, reason?: string): void {
    this.clients.delete(ws);
    // code/reason help diagnose abnormal disconnects — e.g. 1009 (message too
    // big), 1006 (abnormal closure). Empty reason and code 1000 are normal.
    const codeStr = code !== undefined ? String(code) : '?';
    const reasonStr = reason !== undefined && reason.length > 0 ? ` reason="${reason}"` : '';
    console.log(`[WS] client disconnected (total: ${this.clients.size}) code=${codeStr}${reasonStr}`);
  }

  sendSnapshot(ws: WsClient, agents: AgentState[], configDirs: readonly string[]): void {
    const event: WsEvent = { type: 'snapshot', agents, configDirs: [...configDirs] };
    const data = JSON.stringify(event);
    const bytes = Buffer.byteLength(data, 'utf8');
    console.log(`[WS] snapshot bytes=${bytes} agents=${agents.length}`);
    if (bytes > LARGE_MESSAGE_WARN_BYTES) {
      console.warn(`[WS] large snapshot frame: ${bytes} bytes (warn threshold: ${LARGE_MESSAGE_WARN_BYTES})`);
    }
    ws.send(data);
  }

  broadcastAgentUpdate(agent: AgentState): void {
    this.broadcast({ type: 'agent:update', agent });
  }

  broadcastNewAgent(agent: AgentState): void {
    this.broadcast({ type: 'agent:new', agent });
  }

  broadcastAgentComplete(id: string): void {
    this.broadcast({ type: 'agent:complete', id });
  }

  broadcastActivityLog(agentId: string, action: string, detail: string, timestamp: number): void {
    this.broadcast({ type: 'activity:log', agentId, action, detail, timestamp });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private broadcast(event: WsEvent): void {
    const data = JSON.stringify(event);
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > LARGE_MESSAGE_WARN_BYTES) {
      console.warn(`[WS] large ${event.type} frame: ${bytes} bytes (warn threshold: ${LARGE_MESSAGE_WARN_BYTES})`);
    }
    for (const client of this.clients) {
      client.send(data);
    }
  }
}
