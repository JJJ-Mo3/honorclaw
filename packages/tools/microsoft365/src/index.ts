// HonorClaw Tool: Microsoft 365 — Outlook, Calendar, OneDrive, Excel
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'm365_outlook_search',
    'm365_outlook_read',
    'm365_outlook_send',
    'm365_calendar_list',
    'm365_calendar_create',
    'm365_onedrive_search',
    'm365_onedrive_read',
    'm365_onedrive_write',
    'm365_excel_read',
    'm365_excel_write',
  ]),
  // Outlook
  query: z.string().optional(),
  message_id: z.string().optional(),
  to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  content_type: z.enum(['text', 'html']).optional(),
  max_results: z.number().optional(),
  // Calendar
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  // OneDrive
  file_id: z.string().optional(),
  file_path: z.string().optional(),
  content: z.string().optional(),
  name: z.string().optional(),
  // Excel
  spreadsheet_id: z.string().optional(),
  worksheet_name: z.string().optional(),
  range: z.string().optional(),
  values: z.array(z.array(z.unknown())).optional(),
});

type Input = z.infer<typeof InputSchema>;

interface M365Creds {
  tenant_id?: string;
  client_id?: string;
  client_secret?: string;
  access_token?: string;
}

function getCredentials(): M365Creds {
  const raw = process.env.M365_CREDENTIALS;
  if (!raw) throw new Error('M365_CREDENTIALS env var is required');
  return JSON.parse(raw) as M365Creds;
}

async function getClient() {
  const { Client } = await import('@microsoft/microsoft-graph-client');
  const creds = getCredentials();

  if (creds.access_token) {
    return Client.init({
      authProvider: (done: (error: any, accessToken: string | null) => void) => {
        done(null, creds.access_token!);
      },
    });
  }

  // Client credentials flow
  if (!creds.tenant_id || !creds.client_id || !creds.client_secret) {
    throw new Error('M365_CREDENTIALS must contain access_token or tenant_id+client_id+client_secret');
  }

  const tokenUrl = `https://login.microsoftonline.com/${creds.tenant_id}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await fetch(tokenUrl, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  const token = data.access_token;

  return Client.init({
    authProvider: (done: (error: any, accessToken: string | null) => void) => {
      done(null, token);
    },
  });
}

// ── Outlook ────────────────────────────────────────

async function outlookSearch(input: Input) {
  const client = await getClient();
  const q = input.query ?? '';
  const top = input.max_results ?? 20;

  const res = await client
    .api('/me/messages')
    .filter(`contains(subject,'${q.replace(/'/g, "''")}')`)
    .top(top)
    .select('id,subject,from,toRecipients,receivedDateTime,bodyPreview')
    .orderby('receivedDateTime desc')
    .get() as { value: Array<Record<string, unknown>> };

  return {
    messages: (res.value ?? []).map((m: Record<string, unknown>) => ({
      id: m.id,
      subject: m.subject,
      from: m.from,
      to: m.toRecipients,
      received: m.receivedDateTime,
      preview: m.bodyPreview,
    })),
  };
}

async function outlookRead(input: Input) {
  const client = await getClient();
  if (!input.message_id) throw new Error('message_id is required');

  const m = await client
    .api(`/me/messages/${input.message_id}`)
    .select('id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments')
    .get() as Record<string, unknown>;

  let attachments: Array<Record<string, unknown>> = [];
  if (m.hasAttachments) {
    const attRes = await client
      .api(`/me/messages/${input.message_id}/attachments`)
      .select('id,name,contentType,size')
      .get() as { value: Array<Record<string, unknown>> };
    attachments = (attRes.value ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      content_type: a.contentType,
      size: a.size,
    }));
  }

  return {
    id: m.id,
    subject: m.subject,
    from: m.from,
    to: m.toRecipients,
    cc: m.ccRecipients,
    received: m.receivedDateTime,
    body: m.body,
    attachments,
  };
}

async function outlookSend(input: Input) {
  const client = await getClient();
  if (!input.to) throw new Error('to is required');
  if (!input.subject) throw new Error('subject is required');

  const toList = Array.isArray(input.to) ? input.to : [input.to];
  const message = {
    subject: input.subject,
    body: {
      contentType: input.content_type === 'html' ? 'HTML' : 'Text',
      content: input.body ?? '',
    },
    toRecipients: toList.map((email) => ({ emailAddress: { address: email } })),
    ccRecipients: (input.cc ?? []).map((email) => ({ emailAddress: { address: email } })),
  };

  await client.api('/me/sendMail').post({ message, saveToSentItems: true });
  return { sent: true };
}

// ── Calendar ───────────────────────────────────────

async function calendarList(input: Input) {
  const client = await getClient();
  const now = new Date();
  const startTime = input.start_time ?? now.toISOString();
  const endTime = input.end_time ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const res = await client
    .api('/me/calendarView')
    .query({ startDateTime: startTime, endDateTime: endTime })
    .top(input.max_results ?? 50)
    .select('id,subject,start,end,location,attendees,bodyPreview,webLink')
    .orderby('start/dateTime')
    .get() as { value: Array<Record<string, unknown>> };

  return {
    events: (res.value ?? []).map((e: Record<string, unknown>) => ({
      id: e.id,
      subject: e.subject,
      start: e.start,
      end: e.end,
      location: e.location,
      attendees: e.attendees,
      preview: e.bodyPreview,
      web_link: e.webLink,
    })),
  };
}

async function calendarCreate(input: Input) {
  const client = await getClient();
  if (!input.summary) throw new Error('summary is required');
  if (!input.start_time) throw new Error('start_time is required');
  if (!input.end_time) throw new Error('end_time is required');

  const tz = input.timezone ?? 'UTC';
  const event = {
    subject: input.summary,
    body: input.description ? { contentType: 'Text', content: input.description } : undefined,
    start: { dateTime: input.start_time, timeZone: tz },
    end: { dateTime: input.end_time, timeZone: tz },
    location: input.location ? { displayName: input.location } : undefined,
    attendees: input.attendees?.map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    })),
  };

  const res = await client.api('/me/events').post(event) as Record<string, unknown>;
  return {
    event_id: res.id,
    subject: res.subject,
    start: res.start,
    end: res.end,
    web_link: res.webLink,
  };
}

// ── OneDrive ───────────────────────────────────────

async function onedriveSearch(input: Input) {
  const client = await getClient();
  const q = input.query ?? '';

  const res = await client
    .api(`/me/drive/root/search(q='${q.replace(/'/g, "''")}')`)
    .top(input.max_results ?? 20)
    .select('id,name,size,lastModifiedDateTime,webUrl,file,folder')
    .get() as { value: Array<Record<string, unknown>> };

  return {
    files: (res.value ?? []).map((f: Record<string, unknown>) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      modified: f.lastModifiedDateTime,
      web_url: f.webUrl,
      is_folder: !!f.folder,
      mime_type: (f.file as Record<string, unknown> | undefined)?.mimeType,
    })),
  };
}

async function onedriveRead(input: Input) {
  const client = await getClient();

  let apiPath: string;
  if (input.file_id) {
    apiPath = `/me/drive/items/${input.file_id}`;
  } else if (input.file_path) {
    apiPath = `/me/drive/root:/${input.file_path}`;
  } else {
    throw new Error('file_id or file_path is required');
  }

  const meta = await client.api(apiPath).select('id,name,size,lastModifiedDateTime,file').get() as Record<string, unknown>;

  const contentRes = await client.api(`${apiPath}/content`).get() as string;
  let content = typeof contentRes === 'string' ? contentRes : JSON.stringify(contentRes);
  let truncated = false;
  if (Buffer.byteLength(content, 'utf-8') > 500 * 1024) {
    content = content.slice(0, 500 * 1024);
    truncated = true;
  }

  return {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    modified: meta.lastModifiedDateTime,
    content,
    truncated,
  };
}

async function onedriveWrite(input: Input) {
  const client = await getClient();
  if (!input.content) throw new Error('content is required');

  let apiPath: string;
  if (input.file_id) {
    apiPath = `/me/drive/items/${input.file_id}/content`;
  } else if (input.file_path) {
    apiPath = `/me/drive/root:/${input.file_path}:/content`;
  } else if (input.name) {
    apiPath = `/me/drive/root:/${input.name}:/content`;
  } else {
    throw new Error('file_id, file_path, or name is required');
  }

  const res = await client.api(apiPath).put(input.content) as Record<string, unknown>;
  return { id: res.id, name: res.name, web_url: res.webUrl };
}

// ── Excel ──────────────────────────────────────────

async function excelRead(input: Input) {
  const client = await getClient();
  if (!input.spreadsheet_id) throw new Error('spreadsheet_id is required');

  const worksheet = input.worksheet_name ?? 'Sheet1';
  const range = input.range ?? 'A1:Z1000';

  const res = await client
    .api(`/me/drive/items/${input.spreadsheet_id}/workbook/worksheets/${worksheet}/range(address='${range}')`)
    .get() as Record<string, unknown>;

  return {
    address: res.address,
    values: res.values,
    row_count: (res.values as unknown[][])?.length ?? 0,
    column_count: ((res.values as unknown[][])?.[0] ?? []).length,
  };
}

async function excelWrite(input: Input) {
  const client = await getClient();
  if (!input.spreadsheet_id) throw new Error('spreadsheet_id is required');
  if (!input.values) throw new Error('values is required');

  const worksheet = input.worksheet_name ?? 'Sheet1';
  const range = input.range ?? 'A1';

  const res = await client
    .api(`/me/drive/items/${input.spreadsheet_id}/workbook/worksheets/${worksheet}/range(address='${range}')`)
    .patch({ values: input.values }) as Record<string, unknown>;

  return {
    address: res.address,
    updated: true,
    row_count: (res.values as unknown[][])?.length ?? 0,
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  m365_outlook_search: outlookSearch,
  m365_outlook_read: outlookRead,
  m365_outlook_send: outlookSend,
  m365_calendar_list: calendarList,
  m365_calendar_create: calendarCreate,
  m365_onedrive_search: onedriveSearch,
  m365_onedrive_read: onedriveRead,
  m365_onedrive_write: onedriveWrite,
  m365_excel_read: excelRead,
  m365_excel_write: excelWrite,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
