// HonorClaw Tool: PagerDuty — incidents, alerts, on-call schedules
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'pagerduty_list_incidents',
    'pagerduty_read_incident',
    'pagerduty_create_incident',
    'pagerduty_acknowledge_incident',
    'pagerduty_resolve_incident',
    'pagerduty_add_note',
    'pagerduty_list_schedules',
  ]),
  // List incidents
  statuses: z.array(z.enum(['triggered', 'acknowledged', 'resolved'])).optional(),
  service_ids: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  max_results: z.number().optional(),
  // Incident
  incident_id: z.string().optional(),
  // Create incident
  title: z.string().optional(),
  service_id: z.string().optional(),
  urgency: z.enum(['high', 'low']).optional(),
  body: z.string().optional(),
  escalation_policy_id: z.string().optional(),
  // Note
  note_content: z.string().optional(),
  // Requester
  from_email: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface PagerDutyCreds {
  api_key: string;
  from_email?: string;
}

function getCredentials(): PagerDutyCreds {
  const raw = process.env.PAGERDUTY_CREDENTIALS;
  if (!raw) throw new Error('PAGERDUTY_CREDENTIALS env var is required');
  return JSON.parse(raw) as PagerDutyCreds;
}

const PD_BASE = 'https://api.pagerduty.com';

async function pdRequest(method: string, path: string, body?: unknown, fromEmail?: string): Promise<unknown> {
  const creds = getCredentials();
  const axios = (await import('axios')).default;

  const headers: Record<string, string> = {
    Authorization: `Token token=${creds.api_key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const email = fromEmail ?? creds.from_email;
  if (email) {
    headers['From'] = email;
  }

  const res = await axios({
    method,
    url: `${PD_BASE}${path}`,
    headers,
    data: body,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(`PagerDuty API error ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ── List Incidents ─────────────────────────────────

async function listIncidents(input: Input) {
  const params = new URLSearchParams();
  if (input.statuses?.length) {
    for (const s of input.statuses) params.append('statuses[]', s);
  }
  if (input.service_ids?.length) {
    for (const id of input.service_ids) params.append('service_ids[]', id);
  }
  if (input.since) params.set('since', input.since);
  if (input.until) params.set('until', input.until);
  params.set('limit', String(input.max_results ?? 25));
  params.set('sort_by', 'created_at:desc');

  const data = (await pdRequest('GET', `/incidents?${params.toString()}`)) as {
    incidents: Array<Record<string, unknown>>;
    total: number;
  };

  return {
    total: data.total,
    incidents: (data.incidents ?? []).map((i) => ({
      id: i.id,
      incident_number: i.incident_number,
      title: i.title,
      status: i.status,
      urgency: i.urgency,
      service: (i.service as Record<string, unknown> | undefined)?.summary,
      created_at: i.created_at,
      html_url: i.html_url,
      assignments: (i.assignments as Array<Record<string, unknown>> | undefined)?.map(
        (a) => (a.assignee as Record<string, unknown> | undefined)?.summary,
      ),
    })),
  };
}

// ── Read Incident ──────────────────────────────────

async function readIncident(input: Input) {
  if (!input.incident_id) throw new Error('incident_id is required');

  const data = (await pdRequest('GET', `/incidents/${input.incident_id}`)) as {
    incident: Record<string, unknown>;
  };
  const i = data.incident;

  // Get log entries
  const logData = (await pdRequest('GET', `/incidents/${input.incident_id}/log_entries?limit=25`)) as {
    log_entries: Array<Record<string, unknown>>;
  };

  // Get notes
  const notesData = (await pdRequest('GET', `/incidents/${input.incident_id}/notes`)) as {
    notes: Array<Record<string, unknown>>;
  };

  return {
    id: i.id,
    incident_number: i.incident_number,
    title: i.title,
    status: i.status,
    urgency: i.urgency,
    description: i.description,
    service: (i.service as Record<string, unknown> | undefined)?.summary,
    escalation_policy: (i.escalation_policy as Record<string, unknown> | undefined)?.summary,
    created_at: i.created_at,
    updated_at: i.updated_at,
    html_url: i.html_url,
    assignments: (i.assignments as Array<Record<string, unknown>> | undefined)?.map(
      (a) => (a.assignee as Record<string, unknown> | undefined)?.summary,
    ),
    log_entries: (logData.log_entries ?? []).map((l) => ({
      type: l.type,
      summary: l.summary,
      created_at: l.created_at,
      agent: (l.agent as Record<string, unknown> | undefined)?.summary,
    })),
    notes: (notesData.notes ?? []).map((n) => ({
      id: n.id,
      content: n.content,
      user: (n.user as Record<string, unknown> | undefined)?.summary,
      created_at: n.created_at,
    })),
  };
}

// ── Create Incident ────────────────────────────────

async function createIncident(input: Input) {
  if (!input.title) throw new Error('title is required');
  if (!input.service_id) throw new Error('service_id is required');

  const incident: Record<string, unknown> = {
    type: 'incident',
    title: input.title,
    service: { id: input.service_id, type: 'service_reference' },
    urgency: input.urgency ?? 'high',
  };

  if (input.body) {
    incident.body = { type: 'incident_body', details: input.body };
  }
  if (input.escalation_policy_id) {
    incident.escalation_policy = { id: input.escalation_policy_id, type: 'escalation_policy_reference' };
  }

  const data = (await pdRequest('POST', '/incidents', { incident }, input.from_email)) as {
    incident: Record<string, unknown>;
  };

  return {
    id: data.incident.id,
    incident_number: data.incident.incident_number,
    title: data.incident.title,
    status: data.incident.status,
    html_url: data.incident.html_url,
    created: true,
  };
}

// ── Acknowledge Incident ───────────────────────────

async function acknowledgeIncident(input: Input) {
  if (!input.incident_id) throw new Error('incident_id is required');

  const data = (await pdRequest(
    'PUT',
    `/incidents/${input.incident_id}`,
    {
      incident: {
        type: 'incident_reference',
        status: 'acknowledged',
      },
    },
    input.from_email,
  )) as { incident: Record<string, unknown> };

  return {
    id: data.incident.id,
    status: data.incident.status,
    acknowledged: true,
  };
}

// ── Resolve Incident ───────────────────────────────

async function resolveIncident(input: Input) {
  if (!input.incident_id) throw new Error('incident_id is required');

  const data = (await pdRequest(
    'PUT',
    `/incidents/${input.incident_id}`,
    {
      incident: {
        type: 'incident_reference',
        status: 'resolved',
      },
    },
    input.from_email,
  )) as { incident: Record<string, unknown> };

  return {
    id: data.incident.id,
    status: data.incident.status,
    resolved: true,
  };
}

// ── Add Note ───────────────────────────────────────

async function addNote(input: Input) {
  if (!input.incident_id) throw new Error('incident_id is required');
  if (!input.note_content) throw new Error('note_content is required');

  const data = (await pdRequest(
    'POST',
    `/incidents/${input.incident_id}/notes`,
    { note: { content: input.note_content } },
    input.from_email,
  )) as { note: Record<string, unknown> };

  return {
    note_id: data.note.id,
    content: data.note.content,
    created_at: data.note.created_at,
  };
}

// ── List Schedules ─────────────────────────────────

async function listSchedules(_input: Input) {
  const data = (await pdRequest('GET', '/schedules?limit=100')) as {
    schedules: Array<Record<string, unknown>>;
    total: number;
  };

  return {
    total: data.total,
    schedules: (data.schedules ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      summary: s.summary,
      description: s.description,
      time_zone: s.time_zone,
      html_url: s.html_url,
      users: (s.users as Array<Record<string, unknown>> | undefined)?.map((u) => ({
        id: u.id,
        name: u.summary,
      })),
    })),
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  pagerduty_list_incidents: listIncidents,
  pagerduty_read_incident: readIncident,
  pagerduty_create_incident: createIncident,
  pagerduty_acknowledge_incident: acknowledgeIncident,
  pagerduty_resolve_incident: resolveIncident,
  pagerduty_add_note: addNote,
  pagerduty_list_schedules: listSchedules,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
