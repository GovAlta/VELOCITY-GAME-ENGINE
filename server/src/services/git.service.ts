import { pool } from '../config/database';
import { env } from '../config/environment';
import { decrypt } from '../utils/encryption';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommitNode {
  oid: string;
  message: string;
  committedDate: string;
  additions: number;
  deletions: number;
  author: {
    name: string;
    email: string;
    user?: { login: string; avatarUrl: string } | null;
  };
  parents: { totalCount: number };
}

interface PRNode {
  number: number;
  title: string;
  state: string;
  body: string;
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  baseRefName: string;
  headRefName: string;
  author: { login: string } | null;
  mergedBy: { login: string } | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: { nodes: Array<{ name: string }> };
  reviews: { nodes: Array<{ state: string; author: { login: string } | null; submittedAt: string; body: string }> };
  comments: { nodes: Array<{ author: { login: string } | null; body: string; createdAt: string }> };
  commits: { totalCount: number };
}

interface ContributorData {
  login: string;
  displayName: string;
  avatarUrl: string | null;
  commits: Array<{
    sha: string;
    date: string;
    message: string;
    msgScore: CommitMessageScore;
    additions: number;
    deletions: number;
    isMerge: boolean;
  }>;
  totalAdditions: number;
  totalDeletions: number;
  totalPRsAuthored: number;
  totalPRsMerged: number;
  totalPRsReviewed: number;
  mergesPerformed: number;
  features: number;
  bugs: number;
  refactors: number;
  docs: number;
  ci: number;
  tests: number;
  otherPRTypes: number;
  msgQualityScores: number[];
  dailyActivity: Record<string, number>;
  weeklyActivity: Record<string, number>;
  monthlyActivity: Record<string, number>;
  dailyLines: Record<string, { additions: number; deletions: number; commits: number }>;
  prComments: Array<{ prNumber: number; prTitle: string; body: string; createdAt: string }>;
  reviewComments: Array<{ prNumber: number; prTitle: string; body: string; state: string; submittedAt: string }>;
  compositeScore: number;
  scoreBreakdown: Record<string, number>;
  avgMsgQuality: number;
}

interface CommitMessageScore {
  subject: string;
  rawLength: number;
  hasBody: boolean;
  isConventional: boolean;
  lengthScore: number;
  wordScore: number;
  qualityScore: number;
}

interface PRDetail {
  number: number;
  title: string;
  type: string;
  state: string;
  merged: boolean;
  author: string;
  mergedBy: string | null;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commitsCount: number;
  commentsCount: number;
  bodyLength: number;
  bodyPreview: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  cycleHours: number | null;
  baseBranch: string;
  headBranch: string;
  reviews: Array<{
    reviewer: string;
    state: string;
    submittedAt: string;
    hasBody: boolean;
    bodyPreview: string;
  }>;
  comments: Array<{
    author: string;
    body: string;
    createdAt: string;
  }>;
}

export interface ExtractionResult {
  projectHealth: Record<string, unknown>;
  contributors: Record<string, ContributorData>;
  prDetails: Record<number, PRDetail>;
  reviewerStats: Record<string, unknown>;
  llmBundles: Record<string, unknown>;
  meta: Record<string, unknown>;
}

interface ExtractionOptions {
  branch?: string;
  maxCommits?: number;
  since?: string | null;
  onProgress?: (p: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// GraphQL Queries
// ---------------------------------------------------------------------------

const COMMITS_QUERY = `
query($owner:String!, $repo:String!, $branch:String!, $after:String, $since:GitTimestamp) {
  repository(owner:$owner, name:$repo) {
    ref(qualifiedName:$branch) {
      target { ... on Commit {
        history(first:100, after:$after, since:$since) {
          pageInfo { hasNextPage endCursor }
          nodes {
            oid message committedDate additions deletions
            author { name email user { login avatarUrl } }
            parents { totalCount }
          }
        }
      }}
    }
  }
}`;

const PRS_QUERY = `
query($owner:String!, $repo:String!, $after:String, $states:[PullRequestState!]) {
  repository(owner:$owner, name:$repo) {
    pullRequests(first:50, after:$after, states:$states, orderBy:{field:CREATED_AT, direction:DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state body createdAt closedAt mergedAt
        baseRefName headRefName
        author { login } mergedBy { login }
        additions deletions changedFiles
        labels(first:10) { nodes { name } }
        reviews(first:50) { nodes { state author { login } submittedAt body } }
        comments(first:50) { nodes { author { login } body createdAt } }
        commits { totalCount }
      }
    }
  }
}`;

const BRANCHES_QUERY = `
query($owner:String!, $repo:String!, $after:String) {
  repository(owner:$owner, name:$repo) {
    refs(refPrefix:"refs/heads/", first:100, after:$after) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Default GitHub endpoints — overridden by user's stored domain for enterprise instances
const DEFAULT_DOMAIN = 'github.com';
function ghGraphql(domain: string): string {
  return domain === 'github.com' ? 'https://api.github.com/graphql' : `https://${domain}/api/v3/graphql`;
}
function ghRest(domain: string): string {
  return domain === 'github.com' ? 'https://api.github.com' : `https://${domain}/api/v3`;
}
// Legacy constants for backward compatibility within this file
const GH_GRAPHQL = 'https://api.github.com/graphql';
const GH_REST = 'https://api.github.com';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function scoreCommitMessage(msg: string = ''): CommitMessageScore {
  const lines = msg.trim().split('\n');
  const subject = lines[0].trim();
  const body = lines.slice(2).join('\n').trim();
  const CONV = /^(feat|fix|chore|docs|style|refactor|perf|test|ci|build|revert|hotfix|wip)(\(.+\))?[!:]?\s/i;
  const isConventional = CONV.test(subject);

  let lengthScore: number;
  const len = subject.length;
  if (len === 0) lengthScore = 0;
  else if (len < 10) lengthScore = len * 5;
  else if (len <= 72) lengthScore = 100;
  else lengthScore = Math.max(50, 100 - (len - 72) * 2);

  const wordCount = subject.split(/\s+/).filter(Boolean).length;
  const wordScore = Math.min(100, wordCount * 20);
  const qualityScore = Math.round(lengthScore * 0.4 + wordScore * 0.3 + (isConventional ? 30 : 0));

  return {
    subject: subject.slice(0, 120),
    rawLength: len,
    hasBody: body.length > 0,
    isConventional,
    lengthScore,
    wordScore,
    qualityScore,
  };
}

function classifyPR(title: string = '', labels: string[] = []): string {
  const text = (title + ' ' + labels.join(' ')).toLowerCase();
  if (/\b(bug|fix|hotfix|patch|regression|crash|error|defect)\b/.test(text)) return 'bug';
  if (/\b(feat|feature|enhancement|add|new|implement|build)\b/.test(text)) return 'feature';
  if (/\b(refactor|cleanup|clean|chore|tech.?debt|improve|optimis)\b/.test(text)) return 'refactor';
  if (/\b(doc|readme|changelog|wiki)\b/.test(text)) return 'docs';
  if (/\b(ci|cd|pipeline|workflow|action|deploy|release)\b/.test(text)) return 'ci';
  if (/\b(test|spec|coverage)\b/.test(text)) return 'test';
  return 'other';
}

function isoToDateKey(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

function isoToWeekKey(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isoToMonthKey(iso: string | null): string | null {
  return iso ? iso.slice(0, 7) : null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);
}

function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const urlMatch = input.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  const parts = input.split('/');
  if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
  return null;
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/**
 * Returns the user's decrypted PAT if available, otherwise falls back to env.GITHUB_PAT.
 */
export interface GitHubCredentials {
  token: string;
  domain: string;
  org: string | null;
  graphqlUrl: string;
  restUrl: string;
}

/**
 * Get the GitHub token and domain for a user.
 * Checks user's encrypted PAT + stored domain first, falls back to system env.
 * The returned credentials include resolved API URLs for the domain.
 */
export async function getGitHubCredentials(userId?: string): Promise<GitHubCredentials> {
  if (userId) {
    try {
      const result = await pool.query(
        `SELECT user_github_pat_encrypted, user_github_pat_iv, user_github_domain, user_github_org
         FROM user_account
         WHERE pk_user_account = $1
           AND user_github_pat_encrypted IS NOT NULL`,
        [userId]
      );
      if (result.rows.length > 0) {
        const { user_github_pat_encrypted, user_github_pat_iv, user_github_domain, user_github_org } = result.rows[0];
        if (user_github_pat_encrypted && user_github_pat_iv) {
          const token = decrypt(user_github_pat_encrypted, user_github_pat_iv);
          const domain = user_github_domain || DEFAULT_DOMAIN;
          return { token, domain, org: user_github_org || null, graphqlUrl: ghGraphql(domain), restUrl: ghRest(domain) };
        }
      }
    } catch (err) {
      logger.warn('Failed to decrypt user PAT, falling back to env', { userId, error: (err as Error).message });
    }
  }

  if (!env.GITHUB_PAT) {
    throw AppError.badRequest('No GitHub PAT configured. Set GITHUB_PAT in environment or save a personal token via Settings.');
  }
  return { token: env.GITHUB_PAT, domain: DEFAULT_DOMAIN, org: null, graphqlUrl: GH_GRAPHQL, restUrl: GH_REST };
}

/**
 * Parse a GitHub URL like "https://github.com/your-org" into { domain, org }.
 * Handles: github.com/org, github.enterprise.com/org, just "github.com", etc.
 */
export function parseGitHubUrl(url: string): { domain: string; org: string | null } {
  if (!url) return { domain: DEFAULT_DOMAIN, org: null };
  // Strip trailing slash
  const cleaned = url.replace(/\/+$/, '');
  try {
    const parsed = new URL(cleaned.startsWith('http') ? cleaned : `https://${cleaned}`);
    const domain = parsed.hostname;
    // The org is the first path segment (e.g., /your-org)
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const org = pathParts[0] || null;
    return { domain, org };
  } catch {
    // Not a URL — might be just a domain like "github.com"
    return { domain: cleaned, org: null };
  }
}

/** Legacy wrapper — returns just the token string. */
export async function getGitHubToken(userId?: string): Promise<string> {
  const creds = await getGitHubCredentials(userId);
  return creds.token;
}

// ---------------------------------------------------------------------------
// GraphQL client with rate-limit handling
// ---------------------------------------------------------------------------

export async function graphqlQuery(
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<Record<string, unknown> | null> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'velo-git-service/1.0',
  };

  while (true) {
    const res = await fetch(GH_GRAPHQL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });

    const rateLimitRemaining = parseInt(res.headers.get('x-ratelimit-remaining') || '100', 10);

    if (res.status === 403 || rateLimitRemaining < 3) {
      const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10);
      const wait = Math.max(reset * 1000 - Date.now(), 5000);
      logger.warn('GitHub rate limit reached, waiting', { wait: Math.ceil(wait / 1000) });
      await sleep(wait);
      continue;
    }

    // Check for non-JSON responses (404 HTML pages, etc.)
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      const text = await res.text();
      if (res.status === 404) {
        throw AppError.badRequest(`Repository not found. Check that the repo exists and your PAT has access.`);
      }
      throw AppError.badRequest(`GitHub returned non-JSON response (${res.status}): ${text.substring(0, 200)}`);
    }

    let json: { data?: Record<string, unknown>; errors?: Array<{ message: string; type?: string }> };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw AppError.badRequest(`Failed to parse GitHub response (status ${res.status}). The repository may not exist or your PAT may lack access.`);
    }

    if (json.errors) {
      const msgs = json.errors.map((e) => e.message).join('; ');
      const isFatal = json.errors.some(
        (e) =>
          e.type === 'NOT_FOUND' ||
          (e.message || '').includes('SAML enforcement') ||
          (e.message || '').includes('must grant') ||
          (e.message || '').includes('Resource protected')
      );
      if (isFatal) {
        throw AppError.badRequest(
          `GitHub API error: ${msgs}. You may need to authorize your PAT for SSO at https://github.com/settings/tokens`
        );
      }
      logger.error('GraphQL error (non-fatal)', { errors: msgs });
      return null;
    }

    return json.data || null;
  }
}

// ---------------------------------------------------------------------------
// REST helpers for GitHub API
// ---------------------------------------------------------------------------

function restHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'velo-git-service/1.0',
  };
}

async function restGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${GH_REST}${path}`, { headers: restHeaders(token) });
  if (!res.ok) {
    const text = await res.text();
    throw AppError.badRequest(`GitHub REST API error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function restPost(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GH_REST}${path}`, {
    method: 'POST',
    headers: { ...restHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw AppError.badRequest(`GitHub REST API error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function restPut(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GH_REST}${path}`, {
    method: 'PUT',
    headers: { ...restHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw AppError.badRequest(`GitHub REST API error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function restPatch(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GH_REST}${path}`, {
    method: 'PATCH',
    headers: { ...restHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw AppError.badRequest(`GitHub REST API error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Extraction functions
// ---------------------------------------------------------------------------

export async function extractBranches(
  token: string,
  owner: string,
  repo: string
): Promise<string[]> {
  const branches: string[] = [];
  let after: string | null = null;

  while (true) {
    const data = await graphqlQuery(token, BRANCHES_QUERY, { owner, repo, after });
    const conn = (data as any)?.repository?.refs;
    if (!conn) break;
    branches.push(...conn.nodes.map((n: { name: string }) => n.name));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return branches;
}

export async function extractCommits(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  since?: string | null,
  maxCommits: number = 10000
): Promise<CommitNode[]> {
  const commitMap = new Map<string, CommitNode>();
  let after: string | null = null;
  const sinceISO = since ? new Date(since).toISOString() : null;

  while (commitMap.size < maxCommits) {
    const data = await graphqlQuery(token, COMMITS_QUERY, {
      owner,
      repo,
      branch,
      after,
      since: sinceISO,
    });
    const hist = (data as any)?.repository?.ref?.target?.history;
    if (!hist) break;

    for (const node of hist.nodes as CommitNode[]) {
      if (!commitMap.has(node.oid)) {
        commitMap.set(node.oid, node);
      }
    }

    if (!hist.pageInfo.hasNextPage || commitMap.size >= maxCommits) break;
    after = hist.pageInfo.endCursor;
  }

  return [...commitMap.values()];
}

export async function extractPRs(
  token: string,
  owner: string,
  repo: string
): Promise<PRNode[]> {
  const rawPRs: PRNode[] = [];

  for (const state of ['OPEN', 'CLOSED', 'MERGED']) {
    let cursor: string | null = null;
    let pg = 0;

    while (true) {
      pg++;
      const data = await graphqlQuery(token, PRS_QUERY, {
        owner,
        repo,
        after: cursor,
        states: [state],
      });
      const conn = (data as any)?.repository?.pullRequests;
      if (!conn) break;
      rawPRs.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage || pg > 100) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  return rawPRs;
}

// ---------------------------------------------------------------------------
// Contributor analytics builder (ported from extract.js)
// ---------------------------------------------------------------------------

export function buildContributorAnalytics(
  rawCommits: CommitNode[],
  rawPRs: PRNode[],
  owner: string,
  repo: string,
  branches: string[],
  usedBranch: string
): Omit<ExtractionResult, 'meta'> {
  // Build PR map
  const prMap: Record<number, PRDetail> = {};
  for (const pr of rawPRs) {
    const labels = pr.labels.nodes.map((l) => l.name);
    const prType = classifyPR(pr.title, labels);
    const reviews = pr.reviews.nodes.map((r) => ({
      reviewer: r.author?.login || 'ghost',
      state: r.state,
      submittedAt: r.submittedAt,
      hasBody: (r.body || '').trim().length > 0,
      bodyPreview: (r.body || '').trim().slice(0, 300),
    }));
    const comments = (pr.comments?.nodes || []).map((c) => ({
      author: c.author?.login || 'ghost',
      body: (c.body || '').trim().slice(0, 500),
      createdAt: c.createdAt,
    }));
    const cycleHours =
      pr.mergedAt && pr.createdAt
        ? parseFloat(((new Date(pr.mergedAt).getTime() - new Date(pr.createdAt).getTime()) / 3_600_000).toFixed(1))
        : null;

    prMap[pr.number] = {
      number: pr.number,
      title: pr.title,
      type: prType,
      state: pr.state,
      merged: pr.state === 'MERGED',
      author: pr.author?.login || 'ghost',
      mergedBy: pr.mergedBy?.login || null,
      labels,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      commitsCount: pr.commits.totalCount,
      commentsCount: comments.length,
      bodyLength: (pr.body || '').length,
      bodyPreview: (pr.body || '').slice(0, 500),
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      cycleHours,
      baseBranch: pr.baseRefName,
      headBranch: pr.headRefName,
      reviews,
      comments,
    };
  }

  // Reviewer stats
  const reviewerStats: Record<string, { approvals: number; changesRequested: number; comments: number; prsReviewedCount: number; _prs: Set<number> }> = {};
  for (const pr of Object.values(prMap)) {
    for (const rv of pr.reviews) {
      if (!reviewerStats[rv.reviewer]) {
        reviewerStats[rv.reviewer] = { approvals: 0, changesRequested: 0, comments: 0, prsReviewedCount: 0, _prs: new Set() };
      }
      reviewerStats[rv.reviewer]._prs.add(pr.number);
      if (rv.state === 'APPROVED') reviewerStats[rv.reviewer].approvals++;
      else if (rv.state === 'CHANGES_REQUESTED') reviewerStats[rv.reviewer].changesRequested++;
      else if (rv.state === 'COMMENTED') reviewerStats[rv.reviewer].comments++;
    }
  }
  const cleanReviewerStats: Record<string, { approvals: number; changesRequested: number; comments: number; prsReviewedCount: number }> = {};
  for (const [key, r] of Object.entries(reviewerStats)) {
    cleanReviewerStats[key] = { approvals: r.approvals, changesRequested: r.changesRequested, comments: r.comments, prsReviewedCount: r._prs.size };
  }

  // Per-user analytics
  const users: Record<string, ContributorData> = {};
  const getUser = (login: string, displayName?: string, avatarUrl?: string | null): ContributorData => {
    if (!users[login]) {
      users[login] = {
        login,
        displayName: displayName || login,
        avatarUrl: avatarUrl || null,
        commits: [],
        totalAdditions: 0,
        totalDeletions: 0,
        totalPRsAuthored: 0,
        totalPRsMerged: 0,
        totalPRsReviewed: 0,
        mergesPerformed: 0,
        features: 0,
        bugs: 0,
        refactors: 0,
        docs: 0,
        ci: 0,
        tests: 0,
        otherPRTypes: 0,
        msgQualityScores: [],
        dailyActivity: {},
        weeklyActivity: {},
        monthlyActivity: {},
        dailyLines: {},
        prComments: [],
        reviewComments: [],
        compositeScore: 0,
        scoreBreakdown: {},
        avgMsgQuality: 0,
      };
    }
    return users[login];
  };

  // Process commits
  for (const c of rawCommits) {
    const login = c.author?.user?.login || slugify(c.author?.name || 'unknown');
    const u = getUser(login, c.author?.name || login, c.author?.user?.avatarUrl || null);
    const msgScore = scoreCommitMessage(c.message);
    const isMerge = c.parents?.totalCount > 1;

    u.totalAdditions += c.additions || 0;
    u.totalDeletions += c.deletions || 0;
    u.msgQualityScores.push(msgScore.qualityScore);
    if (isMerge) u.mergesPerformed++;

    const day = isoToDateKey(c.committedDate);
    const week = isoToWeekKey(c.committedDate);
    const month = isoToMonthKey(c.committedDate);

    if (day) {
      u.dailyActivity[day] = (u.dailyActivity[day] || 0) + 1;
      if (!u.dailyLines[day]) u.dailyLines[day] = { additions: 0, deletions: 0, commits: 0 };
      u.dailyLines[day].additions += c.additions || 0;
      u.dailyLines[day].deletions += c.deletions || 0;
      u.dailyLines[day].commits += 1;
    }
    if (week) u.weeklyActivity[week] = (u.weeklyActivity[week] || 0) + 1;
    if (month) u.monthlyActivity[month] = (u.monthlyActivity[month] || 0) + 1;

    u.commits.push({
      sha: c.oid.slice(0, 10),
      date: c.committedDate,
      message: c.message.slice(0, 300),
      msgScore,
      additions: c.additions || 0,
      deletions: c.deletions || 0,
      isMerge,
    });
  }

  // Process PRs
  for (const pr of Object.values(prMap)) {
    const u = getUser(pr.author);
    u.totalPRsAuthored++;
    if (pr.merged) u.totalPRsMerged++;
    const t = pr.type;
    if (t === 'feature') u.features++;
    else if (t === 'bug') u.bugs++;
    else if (t === 'refactor') u.refactors++;
    else if (t === 'docs') u.docs++;
    else if (t === 'ci') u.ci++;
    else if (t === 'test') u.tests++;
    else u.otherPRTypes++;

    if (pr.mergedBy) getUser(pr.mergedBy).mergesPerformed++;

    for (const comment of pr.comments) {
      getUser(comment.author).prComments.push({
        prNumber: pr.number,
        prTitle: pr.title,
        body: comment.body,
        createdAt: comment.createdAt,
      });
    }
    for (const rv of pr.reviews) {
      if (rv.bodyPreview) {
        getUser(rv.reviewer).reviewComments.push({
          prNumber: pr.number,
          prTitle: pr.title,
          body: rv.bodyPreview,
          state: rv.state,
          submittedAt: rv.submittedAt,
        });
      }
    }
  }

  // Assign reviewer counts
  for (const [reviewer, rs] of Object.entries(cleanReviewerStats)) {
    getUser(reviewer).totalPRsReviewed = rs.prsReviewedCount;
  }

  // Composite scoring
  computeScores(users);

  // Project health
  const allDates = rawCommits.map((c) => c.committedDate).filter(Boolean).sort();
  const velocityByMonth: Record<string, number> = {};
  const velocityByDay: Record<string, number> = {};
  for (const c of rawCommits) {
    const m = isoToMonthKey(c.committedDate);
    if (m) velocityByMonth[m] = (velocityByMonth[m] || 0) + 1;
    const d = isoToDateKey(c.committedDate);
    if (d) velocityByDay[d] = (velocityByDay[d] || 0) + 1;
  }

  const mergedPRs = Object.values(prMap).filter((p) => p.merged);
  const prTypeDist: Record<string, number> = {};
  for (const p of Object.values(prMap)) prTypeDist[p.type] = (prTypeDist[p.type] || 0) + 1;

  const cycleTimes = mergedPRs.map((p) => p.cycleHours).filter((h): h is number => h !== null);
  const avgCycleHours = cycleTimes.length
    ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length)
    : null;

  const mergeMap: Record<string, Record<string, number>> = {};
  for (const pr of Object.values(prMap)) {
    if (pr.merged && pr.mergedBy) {
      if (!mergeMap[pr.mergedBy]) mergeMap[pr.mergedBy] = {};
      mergeMap[pr.mergedBy][pr.author] = (mergeMap[pr.mergedBy][pr.author] || 0) + 1;
    }
  }

  const projectHealth = {
    repo: `${owner}/${repo}`,
    branch: usedBranch,
    totalCommits: rawCommits.length,
    totalPRs: Object.keys(prMap).length,
    totalMergedPRs: mergedPRs.length,
    totalBranches: branches.length,
    featureBranches: branches.filter((b) => !['dev', 'main', 'master', 'develop', 'staging', 'release'].includes(b)).length,
    firstCommit: allDates[0] || null,
    lastCommit: allDates[allDates.length - 1] || null,
    prTypeDist,
    velocityByMonth: Object.fromEntries(Object.entries(velocityByMonth).sort()),
    velocityByDay: Object.fromEntries(Object.entries(velocityByDay).sort()),
    avgCycleHours,
    mergeMap,
    generatedAt: new Date().toISOString(),
  };

  // LLM bundles
  const llmBundles: Record<string, unknown> = {};
  for (const [login, u] of Object.entries(users)) {
    const rc = [...u.commits].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 50);
    const userPRs = Object.values(prMap)
      .filter((p) => p.author === login)
      .slice(0, 30)
      .map((p) => ({
        number: p.number,
        title: p.title,
        type: p.type,
        bodyLength: p.bodyLength,
        bodyPreview: p.bodyPreview,
        cycleHours: p.cycleHours,
        additions: p.additions,
        deletions: p.deletions,
        state: p.state,
        reviews: p.reviews,
      }));

    const prCommentsText =
      u.prComments
        .slice(0, 15)
        .map((c) => `- PR #${c.prNumber}: "${c.body.slice(0, 150)}"`)
        .join('\n') || 'None';
    const reviewCommentsText =
      u.reviewComments
        .slice(0, 15)
        .map((c) => `- PR #${c.prNumber} [${c.state}]: "${c.body.slice(0, 150)}"`)
        .join('\n') || 'None';

    const dailyEntries = Object.entries(u.dailyLines || {}).sort();
    const activeDays = dailyEntries.length;
    const totalDays =
      dailyEntries.length > 1
        ? Math.ceil(
            (new Date(dailyEntries[dailyEntries.length - 1][0]).getTime() - new Date(dailyEntries[0][0]).getTime()) /
              86400000
          ) + 1
        : 1;

    llmBundles[login] = {
      login,
      compositeScore: u.compositeScore,
      scoreBreakdown: u.scoreBreakdown,
      stats: {
        totalCommits: u.commits.length,
        totalAdditions: u.totalAdditions,
        totalDeletions: u.totalDeletions,
        totalPRs: u.totalPRsAuthored,
        avgMsgQuality: u.avgMsgQuality,
      },
      commitMessages: rc.map((c) => ({
        date: c.date,
        message: c.message,
        score: c.msgScore.qualityScore,
        lines: c.additions + c.deletions,
      })),
      prs: userPRs,
      prComments: u.prComments.slice(0, 30),
      reviewComments: u.reviewComments.slice(0, 30),
      dailyLines: u.dailyLines,
      llmPrompt: `You are a senior engineering manager reviewing developer "${login}" on ${owner}/${repo}.

## Stats
- Composite score: ${u.compositeScore}/100, Commits: ${u.commits.length}, Lines +${u.totalAdditions}/-${u.totalDeletions}
- PRs authored: ${u.totalPRsAuthored} (${u.features} feat, ${u.bugs} bug, ${u.refactors} refactor, ${u.docs} docs)
- PRs reviewed: ${u.totalPRsReviewed}, Merges: ${u.mergesPerformed}
- Avg commit msg quality: ${u.avgMsgQuality}/100, Active days: ${activeDays}/${totalDays} (${Math.round((activeDays / totalDays) * 100)}%)

## Recent commits
${rc
  .slice(0, 30)
  .map((c, i) => `${i + 1}. [${c.msgScore.qualityScore}] +${c.additions}/-${c.deletions} ${c.message.split('\n')[0]}`)
  .join('\n')}

## PRs
${userPRs.map((p) => `- [${p.type}] #${p.number}: ${p.title} (+${p.additions}/-${p.deletions}) ${p.state}`).join('\n')}

## PR Comments
${prCommentsText}

## Review Comments
${reviewCommentsText}

Evaluate comprehensively. Respond ONLY in JSON:
{"communication":0-10,"codeVolume":0-10,"consistency":0-10,"balance":0-10,"reviewQuality":0-10,"likelyRole":"string","skills":["string"],"strengths":["string"],"growthAreas":["string"],"overall":"top|mid|low","trajectory":"improving|stable|declining","summary":"3-5 sentences"}`,
    };
  }

  // Sort contributors by composite score
  const sortedContributors = Object.fromEntries(
    Object.entries(users).sort((a, b) => b[1].compositeScore - a[1].compositeScore)
  );

  return {
    projectHealth,
    contributors: sortedContributors,
    prDetails: prMap,
    reviewerStats: cleanReviewerStats,
    llmBundles,
  };
}

// ---------------------------------------------------------------------------
// Composite scoring (ported from extract.js)
// ---------------------------------------------------------------------------

function computeScores(users: Record<string, ContributorData>): void {
  const WEIGHTS: Record<string, number> = {
    commits: 0.2,
    lines: 0.15,
    prsAuthored: 0.2,
    reviews: 0.15,
    merges: 0.1,
    msgQuality: 0.1,
    features: 0.05,
    bugs: 0.05,
  };

  const raw: Record<string, Record<string, number>> = {};
  for (const [login, u] of Object.entries(users)) {
    const avgMsg = u.msgQualityScores.length
      ? u.msgQualityScores.reduce((a, b) => a + b, 0) / u.msgQualityScores.length
      : 0;
    raw[login] = {
      commits: u.commits.length,
      lines: u.totalAdditions + u.totalDeletions,
      prsAuthored: u.totalPRsAuthored,
      reviews: u.totalPRsReviewed,
      merges: u.mergesPerformed,
      msgQuality: avgMsg,
      features: u.features,
      bugs: u.bugs,
    };
  }

  const dims = Object.keys(WEIGHTS);
  const normed: Record<string, Record<string, number>> = {};

  for (const dim of dims) {
    const vals = Object.values(raw).map((r) => r[dim]);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const rng = mx - mn || 1;
    for (const login of Object.keys(raw)) {
      if (!normed[login]) normed[login] = {};
      normed[login][dim] = ((raw[login][dim] - mn) / rng) * 100;
    }
  }

  for (const [login, u] of Object.entries(users)) {
    const composite = dims.reduce((sum, d) => sum + normed[login][d] * WEIGHTS[d], 0);
    u.compositeScore = Math.round(composite * 10) / 10;
    u.scoreBreakdown = Object.fromEntries(dims.map((d) => [d, Math.round(normed[login][d] * 10) / 10]));
    u.avgMsgQuality = Math.round((raw[login].msgQuality || 0) * 10) / 10;
  }
}

// ---------------------------------------------------------------------------
// REST API wrappers (file operations, PRs, branches)
// ---------------------------------------------------------------------------

export async function getRepoFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string = ''
): Promise<unknown> {
  const encodedPath = filePath ? `/${encodeURIComponent(filePath).replace(/%2F/g, '/')}` : '';
  return restGet(token, `/repos/${owner}/${repo}/contents${encodedPath}?ref=${encodeURIComponent(branch)}`);
}

export async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string
): Promise<{ content: string; sha: string; size: number; name: string }> {
  const data = (await restGet(
    token,
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`
  )) as { content?: string; sha: string; size: number; name: string; encoding?: string };

  if (!data.content) {
    throw AppError.badRequest('File has no content (may be a directory or too large)');
  }

  const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content: decoded, sha: data.sha, size: data.size, name: data.name };
}

export async function createOrUpdateFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  content: string,
  message: string
): Promise<unknown> {
  const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');

  // Try to get existing file SHA for update
  let sha: string | undefined;
  try {
    const existing = (await restGet(
      token,
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
    )) as { sha: string };
    sha = existing.sha;
  } catch {
    // File doesn't exist yet — creating new
  }

  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  return restPut(token, `/repos/${owner}/${repo}/contents/${encodedPath}`, body);
}

/**
 * Batch commit: create/update multiple files in a single commit using the Git Trees API.
 * This is the preferred approach for pushing project scaffolds or bulk changes.
 *
 * Flow:
 *   1. Get the SHA of the branch's HEAD commit
 *   2. Get the tree SHA from that commit
 *   3. Create blobs for each file
 *   4. Create a new tree with all blobs
 *   5. Create a new commit pointing to the new tree
 *   6. Update the branch ref to point to the new commit
 */
export async function batchCommit(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  message: string,
  files: Array<{ path: string; content: string }>
): Promise<{ sha: string; url: string; filesCommitted: number }> {
  if (files.length === 0) throw AppError.badRequest('No files to commit');

  // 1. Get the branch's latest commit SHA
  const refData = (await restGet(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)) as {
    object: { sha: string };
  };
  const latestCommitSha = refData.object.sha;

  // 2. Get the tree SHA from the latest commit
  const commitData = (await restGet(token, `/repos/${owner}/${repo}/git/commits/${latestCommitSha}`)) as {
    tree: { sha: string };
  };
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs for each file
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];

  for (const file of files) {
    const blob = (await restPost(token, `/repos/${owner}/${repo}/git/blobs`, {
      content: Buffer.from(file.content, 'utf-8').toString('base64'),
      encoding: 'base64',
    })) as { sha: string };

    treeItems.push({
      path: file.path,
      mode: '100644', // regular file
      type: 'blob',
      sha: blob.sha,
    });
  }

  // 4. Create a new tree with all files
  const newTree = (await restPost(token, `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeItems,
  })) as { sha: string };

  // 5. Create a new commit
  const newCommit = (await restPost(token, `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [latestCommitSha],
  })) as { sha: string; html_url: string };

  // 6. Update the branch to point to the new commit
  await restPatch(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: newCommit.sha,
  });

  logger.info('Batch commit successful', { owner, repo, branch, files: files.length, sha: newCommit.sha });

  return { sha: newCommit.sha, url: newCommit.html_url, filesCommitted: files.length };
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body?: string
): Promise<unknown> {
  return restPost(token, `/repos/${owner}/${repo}/pulls`, { head, base, title, body: body || '' });
}

export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string
): Promise<unknown> {
  return restPost(token, `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
}

/**
 * Create a new GitHub repository.
 * If `org` is provided, creates under that organization. Otherwise under the authenticated user.
 */
export async function createRepo(
  token: string,
  name: string,
  description?: string,
  isPrivate = true,
  org?: string
): Promise<{ full_name: string; html_url: string; default_branch: string }> {
  const endpoint = org ? `/orgs/${org}/repos` : '/user/repos';
  const res = await fetch(`${GH_REST}${endpoint}`, {
    method: 'POST',
    headers: { ...restHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: description || '',
      private: isPrivate,
      auto_init: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    // 422 = repo already exists — fetch it instead
    if (res.status === 422 && text.includes('already exists')) {
      const owner = org || await getAuthenticatedUser(token);
      const repoRes = await fetch(`${GH_REST}/repos/${owner}/${name}`, { headers: restHeaders(token) });
      if (repoRes.ok) {
        return (await repoRes.json()) as { full_name: string; html_url: string; default_branch: string };
      }
    }
    throw AppError.badRequest(`GitHub create repo error (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as { full_name: string; html_url: string; default_branch: string };
}

/** Get the authenticated user's login name. */
async function getAuthenticatedUser(token: string): Promise<string> {
  const res = await fetch(`${GH_REST}/user`, { headers: restHeaders(token) });
  if (!res.ok) throw AppError.badRequest('Failed to get GitHub user');
  return ((await res.json()) as { login: string }).login;
}

// ---------------------------------------------------------------------------
// Full extraction orchestrator
// ---------------------------------------------------------------------------

export async function fullExtraction(
  token: string,
  owner: string,
  repo: string,
  options: ExtractionOptions = {}
): Promise<ExtractionResult> {
  const { branch = 'dev', maxCommits = 10000, since = null, onProgress = () => {} } = options;

  // Fetch branches
  onProgress({ type: 'phase', phase: 'branches' });
  const branches = await extractBranches(token, owner, repo);
  onProgress({ type: 'branches', count: branches.length });

  // Determine branch order: primary branch first, then all others
  const primaryCandidates = [branch, 'main', 'master', 'develop', 'dev'];
  const branchOrder: string[] = [];
  for (const b of primaryCandidates) {
    if (branches.includes(b) && !branchOrder.includes(b)) branchOrder.push(b);
  }
  for (const b of branches) {
    if (!branchOrder.includes(b)) branchOrder.push(b);
  }
  if (branchOrder.length === 0) branchOrder.push(branch);

  // Fetch commits from all branches (dedup by SHA)
  onProgress({ type: 'phase', phase: 'commits' });
  const commitMap = new Map<string, CommitNode>();
  const sinceISO = since ? new Date(since).toISOString() : null;
  let usedBranch = branch;

  for (const br of branchOrder) {
    let after: string | null = null;
    let consecutiveDupes = 0;
    const isFirstBranch = br === branchOrder[0];

    while (commitMap.size < maxCommits) {
      const data = await graphqlQuery(token, COMMITS_QUERY, {
        owner,
        repo,
        branch: br,
        after,
        since: sinceISO,
      });
      const hist = (data as any)?.repository?.ref?.target?.history;
      if (!hist) break;

      let pageNewCount = 0;
      for (const node of hist.nodes as CommitNode[]) {
        if (!commitMap.has(node.oid)) {
          commitMap.set(node.oid, node);
          pageNewCount++;
          consecutiveDupes = 0;
        } else {
          consecutiveDupes++;
        }
      }

      onProgress({ type: 'commits', count: commitMap.size, branch: br });
      if (!hist.pageInfo.hasNextPage || commitMap.size >= maxCommits) break;
      if (!isFirstBranch && consecutiveDupes >= 200 && pageNewCount === 0) break;
      after = hist.pageInfo.endCursor;
    }

    if (isFirstBranch) usedBranch = br;
  }

  const rawCommits = [...commitMap.values()];

  // Fetch PRs
  onProgress({ type: 'phase', phase: 'prs' });
  const rawPRs = await extractPRs(token, owner, repo);
  onProgress({ type: 'prs', count: rawPRs.length });

  // Build analytics
  onProgress({ type: 'phase', phase: 'analytics' });
  const analytics = buildContributorAnalytics(rawCommits, rawPRs, owner, repo, branches, usedBranch);

  return {
    ...analytics,
    meta: {
      extractedAt: new Date().toISOString(),
      extractorVersion: '3.0.0',
      repo: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
      branch: usedBranch,
      totalCommitsProcessed: rawCommits.length,
    },
  };
}

export { parseRepoUrl };
