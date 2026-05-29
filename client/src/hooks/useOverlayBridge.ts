import { useCallback, useEffect, useState } from 'react';

interface OverlayState {
  opacity: number;
  glance: boolean;
}

interface OverlayWindow extends Window {
  __AGENT_QUEST_OVERLAY__?: { available?: boolean; opacity?: number; glance?: boolean };
  webkit?: { messageHandlers?: { overlay?: { postMessage: (msg: unknown) => void } } };
}

type OverlayAction =
  | { action: 'setOpacity'; value: number }
  | { action: 'setGlance'; value: boolean }
  | { action: 'setPosition'; value: string }
  | { action: 'hide' }
  | { action: 'reload' }
  | { action: 'openBrowser' }
  | { action: 'restartServer' };

function getBridge(): { postMessage: (msg: unknown) => void } | null {
  const w = window as OverlayWindow;
  return w.webkit?.messageHandlers?.overlay ?? null;
}

export interface OverlayBridge {
  /** True only when the dashboard runs inside the native overlay app. */
  available: boolean;
  opacity: number;
  glance: boolean;
  setOpacity: (v: number) => void;
  setGlance: (on: boolean) => void;
  setPosition: (tag: string) => void;
  hide: () => void;
  reload: () => void;
  openBrowser: () => void;
  restartServer: () => void;
}

/**
 * Bridge to the native macOS overlay panel. In a normal browser the bridge is
 * absent and `available` is false, so callers render nothing. Inside the
 * overlay's WKWebView it drives the panel (opacity, click-through, position …)
 * and stays in sync with changes made from the menu bar.
 */
export function useOverlayBridge(): OverlayBridge {
  const w = window as OverlayWindow;
  const initial = w.__AGENT_QUEST_OVERLAY__;
  const available = Boolean(getBridge()) && Boolean(initial?.available);

  const [state, setState] = useState<OverlayState>({
    opacity: initial?.opacity ?? 1,
    glance: initial?.glance ?? false,
  });

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as Partial<OverlayState> | undefined;
      if (!detail) return;
      setState((prev) => ({
        opacity: typeof detail.opacity === 'number' ? detail.opacity : prev.opacity,
        glance: typeof detail.glance === 'boolean' ? detail.glance : prev.glance,
      }));
    };
    window.addEventListener('agentquest-overlay-state', onState);
    return () => window.removeEventListener('agentquest-overlay-state', onState);
  }, []);

  const send = useCallback((msg: OverlayAction) => {
    getBridge()?.postMessage(msg);
  }, []);

  const setOpacity = useCallback((v: number) => {
    setState((p) => ({ ...p, opacity: v }));
    send({ action: 'setOpacity', value: v });
  }, [send]);

  const setGlance = useCallback((on: boolean) => {
    setState((p) => ({ ...p, glance: on }));
    send({ action: 'setGlance', value: on });
  }, [send]);

  const setPosition = useCallback((tag: string) => send({ action: 'setPosition', value: tag }), [send]);
  const hide = useCallback(() => send({ action: 'hide' }), [send]);
  const reload = useCallback(() => send({ action: 'reload' }), [send]);
  const openBrowser = useCallback(() => send({ action: 'openBrowser' }), [send]);
  const restartServer = useCallback(() => send({ action: 'restartServer' }), [send]);

  return {
    available,
    opacity: state.opacity,
    glance: state.glance,
    setOpacity, setGlance, setPosition, hide, reload, openBrowser, restartServer,
  };
}
