export interface TerminalRecoveryState {
  initialRedrawRequested: boolean;
  webglRecoveryPending: boolean;
}

export function createTerminalRecoveryState(): TerminalRecoveryState {
  return { initialRedrawRequested: false, webglRecoveryPending: false };
}

/** React key for one disposable xterm instance attached to a stable PTY id. */
export function terminalInstanceKey(ptyId: string, generation = 0): string {
  return `${ptyId}:${generation}`;
}

/** Accept output from the current string protocol and the short-lived replay
 * protocol so a renderer hot reload stays usable until the app next exits. */
export function normalizePtyChunk(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'data' in value) {
    const data = (value as { data?: unknown }).data;
    if (typeof data === 'string') return data;
  }
  return '';
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
