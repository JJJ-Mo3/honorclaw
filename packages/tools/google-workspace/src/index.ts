// HonorClaw Tool: Google Workspace — Gmail, Calendar, Drive, Sheets
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'gsuite_gmail_search',
    'gsuite_gmail_read',
    'gsuite_gmail_send',
    'gsuite_calendar_list',
    'gsuite_calendar_create',
    'gsuite_drive_search',
    'gsuite_drive_read',
    'gsuite_drive_write',
    'gsuite_sheets_read',
    'gsuite_sheets_write',
  ]),
  // Gmail
  query: z.string().optional(),
  message_id: z.string().optional(),
  to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  html_body: z.string().optional(),
  max_results: z.number().optional(),
  // Calendar
  calendar_id: z.string().optional(),
  time_min: z.string().optional(),
  time_max: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  location: z.string().optional(),
  timezone: z.string().optional(),
  // Drive
  file_id: z.string().optional(),
  content: z.string().optional(),
  mime_type: z.string().optional(),
  parent_folder_id: z.string().optional(),
  name: z.string().optional(),
  // Sheets
  spreadsheet_id: z.string().optional(),
  range: z.string().optional(),
  values: z.array(z.array(z.unknown())).optional(),
});

type Input = z.infer<typeof InputSchema>;

const MAX_CONTENT_BYTES = 500 * 1024; // 500KB

function getCredentials(): { type: string; credentials: Record<string, unknown> } {
  const raw = process.env.GSUITE_CREDENTIALS;
  if (!raw) throw new Error('GSUITE_CREDENTIALS env var is required');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return { type: (parsed.type as string) ?? 'service_account', credentials: parsed };
}

async function getAuthClient(): Promise<import('googleapis').Auth.GoogleAuth | import('googleapis').Auth.OAuth2Client> {
  const { google } = await import('googleapis');
  const creds = getCredentials();

  if (creds.credentials.access_token) {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({
      access_token: creds.credentials.access_token as string,
      refresh_token: creds.credentials.refresh_token as string | undefined,
    });
    return oauth2;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds.credentials as Record<string, string>,
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
  return auth;
}

// ── Gmail ──────────────────────────────────────────

async function gmailSearch(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth: auth as import('googleapis').Auth.GoogleAuth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: input.query ?? '',
    maxResults: input.max_results ?? 20,
  });

  const messages = res.data.messages ?? [];
  const summaries = await Promise.all(
    messages.slice(0, 50).map(async (m) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: m.id!,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      });
      const headers = detail.data.payload?.headers ?? [];
      const hdr = (name: string) => headers.find((h) => h.name === name)?.value ?? '';
      return {
        id: m.id,
        thread_id: m.threadId,
        subject: hdr('Subject'),
        from: hdr('From'),
        to: hdr('To'),
        date: hdr('Date'),
        snippet: detail.data.snippet ?? '',
      };
    }),
  );
  return { messages: summaries, total: res.data.resultSizeEstimate ?? summaries.length };
}

async function gmailRead(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth: auth as import('googleapis').Auth.GoogleAuth });

  if (!input.message_id) throw new Error('message_id is required');
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: input.message_id,
    format: 'full',
  });

  const headers = res.data.payload?.headers ?? [];
  const hdr = (name: string) => headers.find((h) => h.name === name)?.value ?? '';

  function extractBody(payload: typeof res.data.payload): string {
    if (!payload) return '';
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    }
    const parts = payload.parts ?? [];
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    for (const part of parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    return '';
  }

  const attachments = (res.data.payload?.parts ?? [])
    .filter((p) => p.filename && p.filename.length > 0)
    .map((p) => ({
      filename: p.filename,
      mime_type: p.mimeType,
      size: p.body?.size ?? 0,
      attachment_id: p.body?.attachmentId,
    }));

  return {
    id: res.data.id,
    thread_id: res.data.threadId,
    subject: hdr('Subject'),
    from: hdr('From'),
    to: hdr('To'),
    cc: hdr('Cc'),
    date: hdr('Date'),
    body: extractBody(res.data.payload),
    labels: res.data.labelIds ?? [],
    attachments,
  };
}

async function gmailSend(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth: auth as import('googleapis').Auth.GoogleAuth });

  if (!input.to) throw new Error('to is required');
  if (!input.subject) throw new Error('subject is required');

  const toList = Array.isArray(input.to) ? input.to.join(', ') : input.to;
  const ccLine = input.cc?.length ? `Cc: ${input.cc.join(', ')}\r\n` : '';
  const bccLine = input.bcc?.length ? `Bcc: ${input.bcc.join(', ')}\r\n` : '';
  const contentType = input.html_body ? 'text/html' : 'text/plain';
  const messageBody = input.html_body ?? input.body ?? '';

  const rawMessage = [
    `To: ${toList}\r\n`,
    ccLine,
    bccLine,
    `Subject: ${input.subject}\r\n`,
    `Content-Type: ${contentType}; charset=utf-8\r\n`,
    `\r\n`,
    messageBody,
  ].join('');

  const encoded = Buffer.from(rawMessage).toString('base64url');
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });

  return { message_id: res.data.id, thread_id: res.data.threadId };
}

// ── Calendar ───────────────────────────────────────

async function calendarList(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth: auth as import('googleapis').Auth.GoogleAuth });

  const calId = input.calendar_id ?? 'primary';
  const now = new Date();
  const timeMin = input.time_min ?? now.toISOString();
  const timeMax = input.time_max ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: calId,
    timeMin,
    timeMax,
    maxResults: input.max_results ?? 50,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return {
    events: (res.data.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary,
      description: e.description,
      start: e.start,
      end: e.end,
      location: e.location,
      attendees: e.attendees?.map((a) => ({ email: a.email, status: a.responseStatus })),
      status: e.status,
      html_link: e.htmlLink,
    })),
  };
}

async function calendarCreate(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth: auth as import('googleapis').Auth.GoogleAuth });

  if (!input.summary) throw new Error('summary is required');
  if (!input.start_time) throw new Error('start_time is required');
  if (!input.end_time) throw new Error('end_time is required');

  const tz = input.timezone ?? 'UTC';
  const res = await calendar.events.insert({
    calendarId: input.calendar_id ?? 'primary',
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.start_time, timeZone: tz },
      end: { dateTime: input.end_time, timeZone: tz },
      attendees: input.attendees?.map((email) => ({ email })),
    },
  });

  return {
    event_id: res.data.id,
    html_link: res.data.htmlLink,
    summary: res.data.summary,
    start: res.data.start,
    end: res.data.end,
  };
}

// ── Drive ──────────────────────────────────────────

async function driveSearch(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth: auth as import('googleapis').Auth.GoogleAuth });

  const q = input.query ?? '';
  const res = await drive.files.list({
    q: q.includes("'") ? q : `name contains '${q}' or fullText contains '${q}'`,
    pageSize: input.max_results ?? 20,
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, parents)',
  });

  return {
    files: (res.data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mime_type: f.mimeType,
      size: f.size,
      modified_time: f.modifiedTime,
      web_view_link: f.webViewLink,
    })),
  };
}

async function driveRead(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth: auth as import('googleapis').Auth.GoogleAuth });

  if (!input.file_id) throw new Error('file_id is required');

  const meta = await drive.files.get({
    fileId: input.file_id,
    fields: 'id, name, mimeType, size, modifiedTime',
  });

  const mimeType = meta.data.mimeType ?? '';
  let textContent: string;

  if (mimeType.startsWith('application/vnd.google-apps.')) {
    // Export Google native docs as plain text
    const exportMime =
      mimeType === 'application/vnd.google-apps.spreadsheet'
        ? 'text/csv'
        : 'text/plain';
    const exported = await drive.files.export(
      { fileId: input.file_id, mimeType: exportMime },
      { responseType: 'text' },
    );
    textContent = String(exported.data);
  } else {
    const downloaded = await drive.files.get(
      { fileId: input.file_id, alt: 'media' },
      { responseType: 'text' },
    );
    textContent = String(downloaded.data);
  }

  let truncated = false;
  if (Buffer.byteLength(textContent, 'utf-8') > MAX_CONTENT_BYTES) {
    textContent = textContent.slice(0, MAX_CONTENT_BYTES);
    truncated = true;
  }

  return {
    id: meta.data.id,
    name: meta.data.name,
    mime_type: meta.data.mimeType,
    modified_time: meta.data.modifiedTime,
    content: textContent,
    truncated,
  };
}

async function driveWrite(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth: auth as import('googleapis').Auth.GoogleAuth });

  if (!input.name) throw new Error('name is required');
  if (input.content === undefined) throw new Error('content is required');

  const { Readable } = await import('stream');
  const media = {
    mimeType: input.mime_type ?? 'text/plain',
    body: Readable.from([input.content]),
  };

  if (input.file_id) {
    const res = await drive.files.update({
      fileId: input.file_id,
      requestBody: { name: input.name },
      media,
      fields: 'id, name, webViewLink',
    });
    return { id: res.data.id, name: res.data.name, web_view_link: res.data.webViewLink, updated: true };
  }

  const res = await drive.files.create({
    requestBody: {
      name: input.name,
      parents: input.parent_folder_id ? [input.parent_folder_id] : undefined,
    },
    media,
    fields: 'id, name, webViewLink',
  });
  return { id: res.data.id, name: res.data.name, web_view_link: res.data.webViewLink, created: true };
}

// ── Sheets ─────────────────────────────────────────

async function sheetsRead(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: auth as import('googleapis').Auth.GoogleAuth });

  if (!input.spreadsheet_id) throw new Error('spreadsheet_id is required');
  if (!input.range) throw new Error('range is required');

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: input.spreadsheet_id,
    range: input.range,
  });

  return {
    range: res.data.range,
    values: res.data.values ?? [],
    rows: (res.data.values ?? []).length,
    columns: (res.data.values?.[0] ?? []).length,
  };
}

async function sheetsWrite(input: Input) {
  const { google } = await import('googleapis');
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: auth as import('googleapis').Auth.GoogleAuth });

  if (!input.spreadsheet_id) throw new Error('spreadsheet_id is required');
  if (!input.range) throw new Error('range is required');
  if (!input.values) throw new Error('values is required');

  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: input.spreadsheet_id,
    range: input.range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: input.values },
  });

  return {
    updated_range: res.data.updatedRange,
    updated_rows: res.data.updatedRows,
    updated_columns: res.data.updatedColumns,
    updated_cells: res.data.updatedCells,
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  gsuite_gmail_search: gmailSearch,
  gsuite_gmail_read: gmailRead,
  gsuite_gmail_send: gmailSend,
  gsuite_calendar_list: calendarList,
  gsuite_calendar_create: calendarCreate,
  gsuite_drive_search: driveSearch,
  gsuite_drive_read: driveRead,
  gsuite_drive_write: driveWrite,
  gsuite_sheets_read: sheetsRead,
  gsuite_sheets_write: sheetsWrite,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
