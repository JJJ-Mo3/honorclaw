// HonorClaw Tool: Jira — JQL search, issues, sprints, comments
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'jira_search_issues',
    'jira_read_issue',
    'jira_create_issue',
    'jira_update_issue',
    'jira_add_comment',
    'jira_list_sprints',
  ]),
  // Search
  jql: z.string().optional(),
  max_results: z.number().optional(),
  // Issue
  issue_key: z.string().optional(),
  project_key: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  issue_type: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  // Update fields
  fields: z.record(z.unknown()).optional(),
  transition: z.string().optional(),
  // Comment
  comment_body: z.string().optional(),
  // Sprint
  board_id: z.number().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface JiraCreds {
  base_url: string;
  email: string;
  api_token: string;
}

function getCredentials(): JiraCreds {
  const raw = process.env.JIRA_CREDENTIALS;
  if (!raw) throw new Error('JIRA_CREDENTIALS env var is required');
  return JSON.parse(raw) as JiraCreds;
}

async function jiraRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const creds = getCredentials();
  const axios = (await import('axios')).default;
  const url = `${creds.base_url.replace(/\/$/, '')}/rest/api/3${path}`;
  const auth = Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64');

  const res = await axios({
    method,
    url,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    data: body,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(`Jira API error ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function agileRequest(method: string, path: string): Promise<unknown> {
  const creds = getCredentials();
  const axios = (await import('axios')).default;
  const url = `${creds.base_url.replace(/\/$/, '')}/rest/agile/1.0${path}`;
  const auth = Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64');

  const res = await axios({
    method,
    url,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(`Jira Agile API error ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ── Search ─────────────────────────────────────────

async function searchIssues(input: Input) {
  if (!input.jql) throw new Error('jql is required');

  const data = (await jiraRequest('POST', '/search', {
    jql: input.jql,
    maxResults: input.max_results ?? 20,
    fields: ['summary', 'status', 'assignee', 'priority', 'labels', 'created', 'updated', 'issuetype'],
  })) as { total: number; issues: Array<Record<string, unknown>> };

  return {
    total: data.total,
    issues: data.issues.map((issue: Record<string, unknown>) => {
      const fields = issue.fields as Record<string, unknown> | undefined;
      return {
        key: issue.key,
        summary: fields?.summary,
        status: (fields?.status as Record<string, unknown> | undefined)?.name,
        assignee: (fields?.assignee as Record<string, unknown> | undefined)?.displayName,
        priority: (fields?.priority as Record<string, unknown> | undefined)?.name,
        issue_type: (fields?.issuetype as Record<string, unknown> | undefined)?.name,
        labels: fields?.labels,
        created: fields?.created,
        updated: fields?.updated,
      };
    }),
  };
}

// ── Read Issue ─────────────────────────────────────

async function readIssue(input: Input) {
  if (!input.issue_key) throw new Error('issue_key is required');

  const data = (await jiraRequest('GET', `/issue/${input.issue_key}?expand=renderedFields`)) as Record<string, unknown>;
  const fields = data.fields as Record<string, unknown>;
  const rendered = data.renderedFields as Record<string, unknown> | undefined;

  return {
    key: data.key,
    summary: fields.summary,
    description: rendered?.description ?? fields.description,
    status: (fields.status as Record<string, unknown> | undefined)?.name,
    assignee: (fields.assignee as Record<string, unknown> | undefined)?.displayName,
    reporter: (fields.reporter as Record<string, unknown> | undefined)?.displayName,
    priority: (fields.priority as Record<string, unknown> | undefined)?.name,
    issue_type: (fields.issuetype as Record<string, unknown> | undefined)?.name,
    labels: fields.labels,
    created: fields.created,
    updated: fields.updated,
    components: (fields.components as Array<Record<string, unknown>> | undefined)?.map((c) => c.name),
    comments: ((fields.comment as Record<string, unknown> | undefined)?.comments as Array<Record<string, unknown>> | undefined)?.map((c) => ({
      author: (c.author as Record<string, unknown> | undefined)?.displayName,
      body: c.body,
      created: c.created,
    })),
  };
}

// ── Create Issue ───────────────────────────────────

async function createIssue(input: Input) {
  if (!input.project_key) throw new Error('project_key is required');
  if (!input.summary) throw new Error('summary is required');

  const issueFields: Record<string, unknown> = {
    project: { key: input.project_key },
    summary: input.summary,
    issuetype: { name: input.issue_type ?? 'Task' },
  };

  if (input.description) {
    issueFields.description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: input.description }] }],
    };
  }
  if (input.priority) issueFields.priority = { name: input.priority };
  if (input.assignee) issueFields.assignee = { accountId: input.assignee };
  if (input.labels) issueFields.labels = input.labels;

  const data = (await jiraRequest('POST', '/issue', { fields: issueFields })) as Record<string, unknown>;
  return { key: data.key, id: data.id, self: data.self };
}

// ── Update Issue ───────────────────────────────────

async function updateIssue(input: Input) {
  if (!input.issue_key) throw new Error('issue_key is required');

  const updateFields: Record<string, unknown> = { ...(input.fields ?? {}) };
  if (input.summary) updateFields.summary = input.summary;
  if (input.description) {
    updateFields.description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: input.description }] }],
    };
  }
  if (input.priority) updateFields.priority = { name: input.priority };
  if (input.assignee) updateFields.assignee = { accountId: input.assignee };
  if (input.labels) updateFields.labels = input.labels;

  await jiraRequest('PUT', `/issue/${input.issue_key}`, { fields: updateFields });

  if (input.transition) {
    const transitions = (await jiraRequest('GET', `/issue/${input.issue_key}/transitions`)) as { transitions: Array<Record<string, unknown>> };
    const match = transitions.transitions.find(
      (t) => (t.name as string).toLowerCase() === input.transition!.toLowerCase() || t.id === input.transition,
    );
    if (match) {
      await jiraRequest('POST', `/issue/${input.issue_key}/transitions`, { transition: { id: match.id } });
    }
  }

  return { updated: true, issue_key: input.issue_key };
}

// ── Add Comment ────────────────────────────────────

async function addComment(input: Input) {
  if (!input.issue_key) throw new Error('issue_key is required');
  if (!input.comment_body) throw new Error('comment_body is required');

  const data = (await jiraRequest('POST', `/issue/${input.issue_key}/comment`, {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: input.comment_body }] }],
    },
  })) as Record<string, unknown>;

  return { comment_id: data.id, created: data.created };
}

// ── List Sprints ───────────────────────────────────

async function listSprints(input: Input) {
  if (!input.board_id) throw new Error('board_id is required');

  const data = (await agileRequest('GET', `/board/${input.board_id}/sprint?state=active,future`)) as {
    values: Array<Record<string, unknown>>;
  };

  return {
    sprints: (data.values ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      start_date: s.startDate,
      end_date: s.endDate,
      goal: s.goal,
    })),
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  jira_search_issues: searchIssues,
  jira_read_issue: readIssue,
  jira_create_issue: createIssue,
  jira_update_issue: updateIssue,
  jira_add_comment: addComment,
  jira_list_sprints: listSprints,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
