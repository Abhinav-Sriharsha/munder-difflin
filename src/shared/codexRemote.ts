import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const CODEX_REMOTE_SOCKET_RELATIVE =
  'app-server-control/app-server-control.sock';

/** Keep the CODEX_HOME spelling short enough for macOS's Unix-socket limit. */
export function codexRemoteAliasPath(
  realHome: string,
  agentId: string,
  tempRoot: string
): string {
  const digest = createHash('sha256')
    .update(`${realHome}\0${agentId}`)
    .digest('hex')
    .slice(0, 16);
  return join(tempRoot, 'munder-codex', digest);
}

export function codexRemoteEndpoint(shortHome: string): string {
  return `unix://${join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE)}`;
}

/** Global options must precede `resume`, so prepend the endpoint in all cases. */
export function withCodexRemoteArgs(args: string[], endpoint: string): string[] {
  if (args.includes('--remote')) return args;
  return ['--remote', endpoint, ...args];
}
