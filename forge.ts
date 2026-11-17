// Repository state and the domain operations every surface shares.
//
// One in-memory universe: repositories keyed by name (all owned by the
// viewer), each holding a git object store, refs, labels, issues and pull
// requests. REST, GraphQL and MCP are three projections of these records, so
// an object created through one is the same object through the others, with
// the same id, forever. Issue and pull-request numbers share one per-repo
// counter, exactly like the real thing.

import {
  ObjectStore,
  buildCommitData,
  diffTrees,
  peelToCommit,
  threeWayMerge,
  type FileChange,
} from './store.ts';

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  comments: CommentRec[];
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
}

export interface RepoRec {
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  store: ObjectStore;
  refs: Map<string, string>;
  headRef: string;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  incarnation: number;
  packCache: Map<string, Buffer>;
  mergeCache: Map<string, string>;
}

const COMMITTER_NAME = 'Amber Forge';
const COMMITTER_EMAIL = 'amber-forge@example.invalid';
export const DEFAULT_BRANCH = 'main';

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  private incarnationSeq = 0;

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    this.incarnationSeq += 1;
    const repo: RepoRec = {
      id: this.repoSeq,
      name,
      isPrivate,
      description,
      store: new ObjectStore(),
      refs: new Map(),
      headRef: `refs/heads/${DEFAULT_BRANCH}`,
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      incarnation: this.incarnationSeq,
      packCache: new Map(),
      mergeCache: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): RepoRec | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  createLabel(repo: RepoRec, name: string, color: string): LabelRec | null {
    if (repo.labels.has(name)) return null;
    this.labelSeq += 1;
    const label: LabelRec = { id: this.labelSeq, name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: RepoRec, input: { title: string; body: string; labels: string[] }): IssueRec | { unknownLabel: string } {
    for (const label of input.labels) {
      if (!repo.labels.has(label)) return { unknownLabel: label };
    }
    this.issueSeq += 1;
    const issue: IssueRec = {
      id: this.issueSeq,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(target: { comments: CommentRec[] }, body: string): CommentRec {
    this.commentSeq += 1;
    const comment: CommentRec = { id: this.commentSeq, body };
    target.comments.push(comment);
    return comment;
  }

  /** The record (issue or pull) carrying a number, or undefined. */
  numbered(repo: RepoRec, number: number): IssueRec | PullRec | undefined {
    return repo.issues.get(number) ?? repo.pulls.get(number);
  }

  createPull(repo: RepoRec, input: { title: string; body: string; head: string; base: string }): PullRec | null {
    const headTip = repo.refs.get(`refs/heads/${input.head}`);
    const baseTip = repo.refs.get(`refs/heads/${input.base}`);
    if (headTip === undefined || baseTip === undefined) return null;
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) return null;
    }
    this.pullSeq += 1;
    const pull: PullRec = {
      id: this.pullSeq,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The tip commit of a branch (short name), or null when unborn/absent. */
  branchTip(repo: RepoRec, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return null;
    return peelToCommit(repo.store, oid) ?? oid;
  }

  /** The tree id at a branch tip, or null when the branch has no commit. */
  branchTree(repo: RepoRec, branch: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const commit = repo.store.commitOf(tip);
    return commit === null ? null : commit.tree;
  }

  /** MERGEABLE / CONFLICTING for an open pull, computed once per tip pair. */
  mergeable(repo: RepoRec, pull: PullRec): string {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return 'UNKNOWN';
    const key = `${baseTip}|${headTip}`;
    const hit = repo.mergeCache.get(key);
    if (hit !== undefined) return hit;
    const base = repo.store.mergeBase(baseTip, headTip);
    const baseTree = base === null ? null : (repo.store.commitOf(base)?.tree ?? null);
    const outcome = threeWayMerge(
      repo.store,
      baseTree,
      this.branchTree(repo, pull.baseRef),
      this.branchTree(repo, pull.headRef),
    );
    const verdict = outcome.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
    if (repo.mergeCache.size > 512) repo.mergeCache.clear();
    repo.mergeCache.set(key, verdict);
    return verdict;
  }

  /**
   * Merge a pull request into its base branch. Squash lands one commit with
   * the base tip as its only parent; merge lands a two-parent commit. Either
   * way the tree is the three-way merge against the merge base, and a real
   * conflict refuses with no state changed.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: string): { sha: string } | { conflict: true } | { error: string } {
    if (pull.state !== 'open' || pull.merged) return { error: 'pull request is not open' };
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return { error: 'a branch tip is missing' };
    const base = repo.store.mergeBase(baseTip, headTip);
    const baseTree = base === null ? null : (repo.store.commitOf(base)?.tree ?? null);
    const outcome = threeWayMerge(
      repo.store,
      baseTree,
      this.branchTree(repo, pull.baseRef),
      this.branchTree(repo, pull.headRef),
    );
    if (outcome.conflicts.length > 0) return { conflict: true };
    const nowSec = Math.floor(Date.now() / 1000);
    let data: Buffer;
    if (method === 'merge') {
      data = buildCommitData({
        tree: outcome.tree,
        parents: [baseTip, headTip],
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
        name: COMMITTER_NAME,
        email: COMMITTER_EMAIL,
        whenSec: nowSec,
      });
    } else {
      const body = pull.body === '' ? '' : `\n\n${pull.body}`;
      data = buildCommitData({
        tree: outcome.tree,
        parents: [baseTip],
        message: `${pull.title} (#${pull.number})${body}\n`,
        name: COMMITTER_NAME,
        email: COMMITTER_EMAIL,
        whenSec: nowSec,
      });
    }
    const sha = repo.store.put('commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    return { sha };
  }

  /** Files changed by a pull: merge base tree against head tree. */
  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return [];
    const base = repo.store.mergeBase(baseTip, headTip);
    const fromTree = base === null ? null : (repo.store.commitOf(base)?.tree ?? null);
    return diffTrees(repo.store, fromTree, this.branchTree(repo, pull.headRef));
  }

  /** Write a commit on a branch from a full path->entry map. */
  commitTreeOnBranch(repo: RepoRec, branch: string, tree: string, message: string, parents: string[]): string {
    const data = buildCommitData({
      tree,
      parents,
      message,
      name: COMMITTER_NAME,
      email: COMMITTER_EMAIL,
      whenSec: Math.floor(Date.now() / 1000),
    });
    const sha = repo.store.put('commit', data);
    repo.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }
}

/** Opaque, stable, typed global ids for the GraphQL surface. */
export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}
