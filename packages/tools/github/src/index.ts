// HonorClaw Tool: GitHub — code search, issues, PRs, Actions, files
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'github_search_code',
    'github_list_issues',
    'github_read_issue',
    'github_create_issue',
    'github_list_prs',
    'github_read_pr',
    'github_comment_on_issue',
    'github_trigger_workflow',
    'github_get_file',
  ]),
  // Common
  owner: z.string().optional(),
  repo: z.string().optional(),
  // Search
  query: z.string().optional(),
  max_results: z.number().optional(),
  // Issues / PRs
  issue_number: z.number().optional(),
  pr_number: z.number().optional(),
  state: z.enum(['open', 'closed', 'all']).optional(),
  labels: z.array(z.string()).optional(),
  // Create issue
  title: z.string().optional(),
  body: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  // Comment
  comment_body: z.string().optional(),
  // Workflow
  workflow_id: z.union([z.string(), z.number()]).optional(),
  ref: z.string().optional(),
  inputs: z.record(z.string()).optional(),
  // File
  path: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface GithubCreds {
  token: string;
}

function getCredentials(): GithubCreds {
  const raw = process.env.GITHUB_CREDENTIALS;
  if (!raw) throw new Error('GITHUB_CREDENTIALS env var is required');
  return JSON.parse(raw) as GithubCreds;
}

async function getOctokit() {
  const { Octokit } = await import('@octokit/rest');
  const creds = getCredentials();
  return new Octokit({
    auth: creds.token,
    baseUrl: 'https://api.github.com',
  });
}

function requireOwnerRepo(input: Input): { owner: string; repo: string } {
  if (!input.owner) throw new Error('owner is required');
  if (!input.repo) throw new Error('repo is required');
  return { owner: input.owner, repo: input.repo };
}

// ── Code Search ────────────────────────────────────

async function searchCode(input: Input) {
  const octokit = await getOctokit();
  if (!input.query) throw new Error('query is required');

  const q = input.owner && input.repo
    ? `${input.query} repo:${input.owner}/${input.repo}`
    : input.query;

  const res = await octokit.rest.search.code({
    q,
    per_page: Math.min(input.max_results ?? 20, 100),
  });

  return {
    total_count: res.data.total_count,
    items: res.data.items.map((item) => ({
      name: item.name,
      path: item.path,
      repository: item.repository.full_name,
      html_url: item.html_url,
      score: item.score,
    })),
  };
}

// ── Issues ─────────────────────────────────────────

async function listIssues(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();

  const res = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: input.state ?? 'open',
    labels: input.labels?.join(','),
    per_page: Math.min(input.max_results ?? 30, 100),
  });

  return {
    issues: res.data
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login,
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        assignees: i.assignees?.map((a) => a.login),
        created_at: i.created_at,
        updated_at: i.updated_at,
        comments: i.comments,
        html_url: i.html_url,
      })),
  };
}

async function readIssue(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();
  if (!input.issue_number) throw new Error('issue_number is required');

  const [issue, comments] = await Promise.all([
    octokit.rest.issues.get({ owner, repo, issue_number: input.issue_number }),
    octokit.rest.issues.listComments({ owner, repo, issue_number: input.issue_number, per_page: 50 }),
  ]);

  return {
    number: issue.data.number,
    title: issue.data.title,
    state: issue.data.state,
    body: issue.data.body,
    author: issue.data.user?.login,
    labels: issue.data.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    assignees: issue.data.assignees?.map((a) => a.login),
    created_at: issue.data.created_at,
    updated_at: issue.data.updated_at,
    html_url: issue.data.html_url,
    comments: comments.data.map((c) => ({
      id: c.id,
      author: c.user?.login,
      body: c.body,
      created_at: c.created_at,
    })),
  };
}

async function createIssue(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();
  if (!input.title) throw new Error('title is required');

  const res = await octokit.rest.issues.create({
    owner,
    repo,
    title: input.title,
    body: input.body,
    labels: input.labels,
    assignees: input.assignees,
  });

  return {
    number: res.data.number,
    title: res.data.title,
    html_url: res.data.html_url,
    state: res.data.state,
  };
}

// ── Pull Requests ──────────────────────────────────

async function listPRs(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();

  const res = await octokit.rest.pulls.list({
    owner,
    repo,
    state: input.state ?? 'open',
    per_page: Math.min(input.max_results ?? 30, 100),
  });

  return {
    pull_requests: res.data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.user?.login,
      head: pr.head.ref,
      base: pr.base.ref,
      draft: pr.draft,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      html_url: pr.html_url,
    })),
  };
}

async function readPR(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();
  if (!input.pr_number) throw new Error('pr_number is required');

  const [pr, files, reviews] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: input.pr_number }),
    octokit.rest.pulls.listFiles({ owner, repo, pull_number: input.pr_number, per_page: 100 }),
    octokit.rest.pulls.listReviews({ owner, repo, pull_number: input.pr_number }),
  ]);

  return {
    number: pr.data.number,
    title: pr.data.title,
    state: pr.data.state,
    body: pr.data.body,
    author: pr.data.user?.login,
    head: pr.data.head.ref,
    base: pr.data.base.ref,
    draft: pr.data.draft,
    mergeable: pr.data.mergeable,
    additions: pr.data.additions,
    deletions: pr.data.deletions,
    changed_files: pr.data.changed_files,
    html_url: pr.data.html_url,
    files: files.data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch?.slice(0, 5000),
    })),
    reviews: reviews.data.map((r) => ({
      id: r.id,
      user: r.user?.login,
      state: r.state,
      body: r.body,
      submitted_at: r.submitted_at,
    })),
  };
}

// ── Comment ────────────────────────────────────────

async function commentOnIssue(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();
  if (!input.issue_number) throw new Error('issue_number is required');
  if (!input.comment_body) throw new Error('comment_body is required');

  const res = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: input.issue_number,
    body: input.comment_body,
  });

  return { comment_id: res.data.id, html_url: res.data.html_url };
}

// ── Workflow ───────────────────────────────────────

async function triggerWorkflow(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();
  if (!input.workflow_id) throw new Error('workflow_id is required');
  if (!input.ref) throw new Error('ref is required');

  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: input.workflow_id,
    ref: input.ref,
    inputs: input.inputs,
  });

  return { triggered: true, workflow_id: input.workflow_id, ref: input.ref };
}

// ── Get File ───────────────────────────────────────

async function getFile(input: Input) {
  const { owner, repo } = requireOwnerRepo(input);
  const octokit = await getOctokit();
  if (!input.path) throw new Error('path is required');

  const res = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: input.path,
    ref: input.ref,
  });

  const data = res.data;
  if (Array.isArray(data)) {
    return {
      type: 'directory',
      entries: data.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type,
        size: e.size,
        html_url: e.html_url,
      })),
    };
  }

  if ('content' in data && data.encoding === 'base64') {
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return {
      type: 'file',
      path: data.path,
      name: data.name,
      size: data.size,
      sha: data.sha,
      content,
      html_url: data.html_url,
    };
  }

  return {
    type: data.type,
    path: data.path,
    name: data.name,
    size: data.size,
    sha: data.sha,
    html_url: data.html_url,
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  github_search_code: searchCode,
  github_list_issues: listIssues,
  github_read_issue: readIssue,
  github_create_issue: createIssue,
  github_list_prs: listPRs,
  github_read_pr: readPR,
  github_comment_on_issue: commentOnIssue,
  github_trigger_workflow: triggerWorkflow,
  github_get_file: getFile,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
