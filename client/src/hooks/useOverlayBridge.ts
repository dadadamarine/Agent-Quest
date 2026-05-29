import { useCallback, useEffect, useState } from 'react';

interface OverlayState {
  opacity: number;
}

interface OverlayWindow extends Window {
  __AGENT_QUEST_OVERLAY__?: { available?: boolean; opacity?: number };
  webkit?: { messageHandlers?: { overlay?: { postMessage: (msg: unknown) => void } } };
}

type OverlayAction =
  | { action: 'setOpacity'; value: number }
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
  setOpacity: (v: number) => void;
  hide: () => void;
  reload: () => void;
  openBrowser: () => void;
  restartServer: () => void;
}

/**
 * Bridge to the native macOS overlay panel. In a normal browser the bridge is
 * absent and `available` is false, so callers render nothing. Inside the
 * overlay's WKWebView it drives the panel (opacity, reload, restart …) and
 * stays in sync with changes made from the menu bar.
 */
export function useOverlayBridge(): OverlayBridge {
  const w = window as OverlayWindow;
  const initial = w.__AGENT_QUEST_OVERLAY__;
  const available = Boolean(getBridge()) && Boolean(initial?.available);

  const [state, setState] = useState<OverlayState>({
    opacity: initial?.opacity ?? 1,
  });

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as Partial<OverlayState> | undefined;
      if (!detail) return;
      setState((prev) => ({
        opacity: typeof detail.opacity === 'number' ? detail.opacity : prev.opacity,
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

  const hide = useCallback(() => send({ action: 'hide' }), [send]);
  const reload = useCallback(() => send({ action: 'reload' }), [send]);
  const openBrowser = useCallback(() => send({ action: 'openBrowser' }), [send]);
  const restartServer = useCallback(() => send({ action: 'restartServer' }), [send]);

  return {
    available,
    opacity: state.opacity,
    setOpacity, hide, reload, openBrowser, restartServer,
  };
}
