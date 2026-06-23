import { Request, Response } from 'express';
import * as gitService from '../services/git.service';
import { pool } from '../config/database';
import { encrypt } from '../utils/encryption';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/app-error';

/**
 * POST /git/extract
 * Run a full Git extraction for a repository.
 */
export async function extract(req: Request, res: Response): Promise<void> {
  const { repoUrl, branch, maxCommits, since } = req.body;
  const userId = req.user?.id as string | undefined;

  const parsed = gitService.parseRepoUrl(repoUrl as string);
  if (!parsed) {
    throw AppError.badRequest('Invalid GitHub repository URL');
  }

  const token = await gitService.getGitHubToken(userId);
  const result = await gitService.fullExtraction(token, parsed.owner, parsed.repo, {
    branch,
    maxCommits,
    since: since || null,
  });

  sendSuccess(res, result);
}

/**
 * GET /git/repos/:owner/:repo/analytics
 * Get analytics for a repository (lightweight extraction — branches + recent commits + PRs).
 */
export async function getAnalytics(req: Request, res: Response): Promise<void> {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  const userId = req.user?.id as string | undefined;

  // Try user token, fall back to env
  let token: string;
  try {
    token = await gitService.getGitHubToken(userId);
  } catch {
    token = await gitService.getGitHubToken();
  }

  const result = await gitService.fullExtraction(token, owner, repo, {
    maxCommits: 500,
  });

  sendSuccess(res, result);
}

/**
 * GET /git/repos/:owner/:repo/files
 * List files in a repository directory.
 */
export async function listFiles(req: Request, res: Response): Promise<void> {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  const filePath = (req.query.path as string) || '';
  const branch = (req.query.branch as string) || 'main';
  const userId = req.user?.id as string | undefined;

  const token = await gitService.getGitHubToken(userId);
  const files = await gitService.getRepoFiles(token, owner, repo, branch, filePath);

  sendSuccess(res, files);
}

/**
 * GET /git/repos/:owner/:repo/files/*
 * Get content of a specific file.
 */
export async function getFile(req: Request, res: Response): Promise<void> {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  // Express wildcard param — the path after /files/
  const filePath = (req.params[0] || '') as string;
  const branch = (req.query.branch as string) || 'main';
  const userId = req.user?.id as string | undefined;

  if (!filePath) {
    throw AppError.badRequest('File path is required');
  }

  const token = await gitService.getGitHubToken(userId);
  const file = await gitService.getFileContent(token, owner, repo, branch, filePath);

  sendSuccess(res, file);
}

/**
 * POST /git/repos/:owner/:repo/commits
 * Create or update a file in the repository.
 */
export async function commitFile(req: Request, res: Response): Promise<void> {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  const { branch, path, content, message } = req.body;
  const userId = req.user?.id as string | undefined;

  const token = await gitService.getGitHubToken(userId);
  const result = await gitService.createOrUpdateFile(
    token, owner, repo, branch as string, path as string, content as string, message as string
  );

  sendSuccess(res, result, 201);
}

/**
 * POST /git/repos/:owner/:repo/pulls
 * Create a pull request. Pass `token` in body to override saved PAT.
 */
export async function createPR(req: Request, res: Response): Promise<void> {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  const { head, base, title, body } = req.body;
  const userId = req.user?.id as string | undefined;

  const token = await gitService.getGitHubToken(userId);
  const result = await gitService.createPullRequest(
    token, owner, repo, head as string, base as string, title as string, body as string | undefined
  );

  sendSuccess(res, result, 201);
}

/**
 * POST /git/repos/:owner/:repo/branches
 * Create a new branch. Pass `token` in body to override saved PAT.
 */
export async function createBranch(req: Request, res: Response): Promise<void> {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  const { branchName, fromSha } = req.body;
  const userId = req.user?.id as string | undefined;

  const token = await gitService.getGitHubToken(userId);
  const result = await gitService.createBranch(
    token, owner, repo, branchName as string, fromSha as string
  );

  sendSuccess(res, result, 201);
}

/**
 * POST /git/repos/:owner/:repo/commits/batch
 * Batch commit: push multiple files in a single commit using the Git Trees API.
 * This is the preferred approach for pushing project scaffolds or any multi-file change.
 */
export async function batchCommit(req: Request, res: Response): Promise<void> {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  const { branch, message, files } = req.body;
  const userId = req.user?.id as string | undefined;

  if (!branch || typeof branch !== 'string') throw AppError.badRequest('branch is required');
  if (!message || typeof message !== 'string') throw AppError.badRequest('message is required');
  if (!Array.isArray(files) || files.length === 0) throw AppError.badRequest('files array is required (non-empty)');

  // Validate each file has path + content
  for (const f of files) {
    if (!f.path || typeof f.path !== 'string') throw AppError.badRequest('Each file must have a path');
    if (typeof f.content !== 'string') throw AppError.badRequest(`File ${f.path} must have string content`);
  }

  const token = await gitService.getGitHubToken(userId);
  const result = await gitService.batchCommit(token, owner, repo, branch, message, files);

  sendSuccess(res, result, 201);
}

/**
 * POST /git/repos
 * Create a new GitHub repository.
 * Body: { name, description?, isPrivate?, org?, token? }
 * - org: GitHub org name (e.g. "developmentation"). If omitted, creates under your account.
 * - token: Optional PAT override. If omitted, uses saved PAT or system GITHUB_PAT.
 */
export async function createRepo(req: Request, res: Response): Promise<void> {
  const { name, description, isPrivate, org } = req.body;
  const userId = req.user?.id as string | undefined;

  if (!name || typeof name !== 'string') {
    throw AppError.badRequest('Repository name is required');
  }

  // Get credentials — includes stored org from user settings
  const creds = await gitService.getGitHubCredentials(userId);

  // Use explicit org from body, or fall back to user's stored org from settings
  const effectiveOrg = org || creds.org || undefined;

  const result = await gitService.createRepo(creds.token, name, description, isPrivate !== false, effectiveOrg);

  sendSuccess(res, result, 201);
}

/**
 * PUT /settings/pat
 * Save a personal access token (encrypted).
 */
export async function savePat(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id as string | undefined;
  if (!userId) {
    throw AppError.unauthorized('Authentication required');
  }

  const { pat, domain } = req.body;
  const { encrypted, iv } = encrypt(pat as string);

  if (domain) {
    // Save PAT + domain together
    await pool.query(
      `UPDATE user_account
       SET user_github_pat_encrypted = $1, user_github_pat_iv = $2, user_github_domain = $3
       WHERE pk_user_account = $4`,
      [encrypted, iv, domain.trim(), userId]
    );
  } else {
    // Save PAT only — preserve existing domain
    await pool.query(
      `UPDATE user_account
       SET user_github_pat_encrypted = $1, user_github_pat_iv = $2
       WHERE pk_user_account = $3`,
      [encrypted, iv, userId]
    );
  }

  sendSuccess(res, { message: 'PAT saved successfully' });
}

/**
 * PUT /settings/github-domain
 * Save the GitHub domain separately (without re-entering the PAT).
 */
export async function saveDomain(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id as string | undefined;
  if (!userId) {
    throw AppError.unauthorized('Authentication required');
  }

  const { domain } = req.body;
  if (!domain || typeof domain !== 'string') {
    throw AppError.badRequest('GitHub URL or domain is required (e.g. https://github.com/MyOrg)');
  }

  // Parse URL → extract domain + org automatically
  const parsed = gitService.parseGitHubUrl(domain.trim());

  await pool.query(
    `UPDATE user_account SET user_github_domain = $1, user_github_org = $2 WHERE pk_user_account = $3`,
    [parsed.domain, parsed.org, userId]
  );

  sendSuccess(res, { message: 'GitHub settings saved', domain: parsed.domain, org: parsed.org });
}

/**
 * DELETE /settings/pat
 * Remove the user's stored PAT.
 */
export async function deletePat(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id as string | undefined;
  if (!userId) {
    throw AppError.unauthorized('Authentication required');
  }

  await pool.query(
    'UPDATE user_account SET user_github_pat_encrypted = NULL, user_github_pat_iv = NULL WHERE pk_user_account = $1',
    [userId]
  );

  sendSuccess(res, { message: 'PAT removed' });
}

/**
 * GET /settings/pat/status
 * Check if a PAT is configured for the current user.
 */
export async function getPatStatus(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id as string | undefined;
  if (!userId) {
    throw AppError.unauthorized('Authentication required');
  }

  const result = await pool.query(
    `SELECT user_github_pat_encrypted IS NOT NULL AS has_pat, user_github_domain, user_github_org
     FROM user_account
     WHERE pk_user_account = $1`,
    [userId]
  );

  const hasPat = result.rows.length > 0 && result.rows[0].has_pat;
  const domain = result.rows[0]?.user_github_domain || 'github.com';
  const org = result.rows[0]?.user_github_org || null;

  sendSuccess(res, { configured: hasPat, domain, org });
}
