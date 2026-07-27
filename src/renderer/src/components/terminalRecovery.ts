export interface TerminalRecoveryState {
  initialRedrawRequested: boolean;
  webglRecoveryPending: boolean;
}

export function createTerminalRecoveryState(): TerminalRecoveryState {
  return { initialRedrawRequested: false, webglRecoveryPending: false };
}

/** Request exactly one redraw after the renderer has subscribed to PTY output. */
export function requestInitialPtyRedraw(
  state: TerminalRecoveryState,
  requestRedraw: () => void
): boolean {
  if (state.initialRedrawRequested) return false;
  state.initialRedrawRequested = true;
  requestRedraw();
  return true;
}

/** Wait two paint frames after WebGL disposal so the DOM renderer can repaint. */
export function scheduleWebglRecovery(
  state: TerminalRecoveryState,
  requestFrame: (cb: () => void) => void,
  recover: () => void
): boolean {
  if (state.webglRecoveryPending) return false;
  state.webglRecoveryPending = true;
  requestFrame(() => requestFrame(() => {
    state.webglRecoveryPending = false;
    recover();
  }));
  return true;
}
