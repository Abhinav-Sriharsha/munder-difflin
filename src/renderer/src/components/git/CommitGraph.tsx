import { useMemo } from 'react';
import { CommitGraph as LibCommitGraph, type Commit, type Branch } from 'commit-graph';

interface CommitLite {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number;
  refs: string[];
}

export interface CommitGraphProps {
  commits: CommitLite[];
  /** Name of the currently checked-out branch, for highlighting. */
  currentBranch?: string | null;
  /** v0.3.4: commit click → per-commit file list / diff in the IDE HISTORY pane. */
  onCommitClick?: (sha: string) => void;
}

// CTH palette → branch lane colors (commit-graph renders raw colors into SVG).
// v0.3.4 recalibration: the muted set, matching tokens.css.
const BRANCH_COLORS = [
  '#4F9FAF', // sky
  '#DCAB3C', // lemon/amber
  '#5CA97A', // mint/sage
  '#D96A62', // coral
  '#9482D3', // lilac
  '#D99168'  // peach
];

const GRAPH_STYLE = {
  commitSpacing: 28,
  branchSpacing: 18,
  nodeRadius: 4,
  branchColors: BRANCH_COLORS
};

function relTime(d: string | number | Date): string {
  const t = typeof d === 'number' ? d / 1000 : new Date(d).getTime() / 1000;
  const delta = Date.now() / 1000 - t;
  if (delta < 60) return `${Math.round(delta)}s`;
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.round(delta / 86400)}d`;
  return `${Math.round(delta / (86400 * 30))}mo`;
}

export function CommitGraph({ commits, currentBranch, onCommitClick }: CommitGraphProps) {
  // Adapt our flat git-log rows into the GitHub-style shape commit-graph expects.
  const libCommits: Commit[] = useMemo(() => commits.map(c => ({
    sha: c.sha,
    commit: {
      author: { name: c.author, date: c.time * 1000 },
      message: c.subject
    },
    parents: c.parents.map(sha => ({ sha }))
  })), [commits]);

  // Branch tips come from the refs git attached to each commit.
  const branchHeads: Branch[] = useMemo(() => {
    const seen = new Set<string>();
    const heads: Branch[] = [];
    for (const c of commits) {
      for (const ref of c.refs) {
        const name = ref.replace('HEAD -> ', '').trim();
        if (!name || name === 'HEAD' || name.startsWith('tag:')) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        heads.push({ name, commit: { sha: c.sha } });
      }
    }
    // Fallback: detached HEAD or no decorations — anchor a head at the newest
    // commit so the library still has a tip to lay out and colour lanes from.
    if (heads.length === 0 && commits.length > 0) {
      heads.push({ name: currentBranch || 'HEAD', commit: { sha: commits[0].sha } });
    }
    return heads;
  }, [commits, currentBranch]);

  return (
    <div className="cth-commit-graph" style={{ padding: '4px 8px', minWidth: 0 }}>
      <LibCommitGraph
        commits={libCommits}
        branchHeads={branchHeads}
        graphStyle={GRAPH_STYLE}
        currentBranch={currentBranch ?? undefined}
        dateFormatFn={relTime}
        onCommitClick={onCommitClick ? (c) => onCommitClick(c.hash) : undefined}
      />
    </div>
  );
}
