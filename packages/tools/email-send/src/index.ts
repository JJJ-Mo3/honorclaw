// HonorClaw Tool: email_send — Send emails via SMTP
import { createTool, z } from '@honorclaw/tool-sdk';
import nodemailer from 'nodemailer';

// ── Email address validation ────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

function validateEmailList(emails: string[], fieldName: string): void {
  for (const email of emails) {
    if (!isValidEmail(email.trim())) {
      throw new Error(`Invalid email address in ${fieldName}: ${email}`);
    }
  }
}

// ── Input schema ────────────────────────────────────────────────────────

const InputSchema = z.object({
  to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
  subject: z.string().min(1).describe('Email subject line'),
  body: z.string().min(1).describe('Email body (plain text or HTML)'),
  cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipient(s)'),
  bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipient(s)'),
  replyTo: z.string().optional().describe('Reply-To address'),
});

type Input = z.infer<typeof InputSchema>;

// ── SMTP transport ──────────────────────────────────────────────────────

function getTransport(): nodemailer.Transporter {
  const host = process.env['SMTP_HOST'];
  const port = process.env['SMTP_PORT'];
  const user = process.env['SMTP_USER'];
  const pass = process.env['SMTP_PASS'];

  if (!host) throw new Error('SMTP_HOST environment variable is required');
  if (!port) throw new Error('SMTP_PORT environment variable is required');

  const portNumber = parseInt(port, 10);
  if (Number.isNaN(portNumber)) throw new Error('SMTP_PORT must be a valid number');

  return nodemailer.createTransport({
    host,
    port: portNumber,
    secure: portNumber === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
}

// ── Send email ──────────────────────────────────────────────────────────

async function sendEmail(input: Input): Promise<{ success: boolean; messageId: string }> {
  // Normalize recipients to arrays
  const toList = Array.isArray(input.to) ? input.to : [input.to];
  const ccList = input.cc ? (Array.isArray(input.cc) ? input.cc : [input.cc]) : [];
  const bccList = input.bcc ? (Array.isArray(input.bcc) ? input.bcc : [input.bcc]) : [];

  // Validate all email addresses
  validateEmailList(toList, 'to');
  if (ccList.length > 0) validateEmailList(ccList, 'cc');
  if (bccList.length > 0) validateEmailList(bccList, 'bcc');
  if (input.replyTo && !isValidEmail(input.replyTo)) {
    throw new Error(`Invalid email address in replyTo: ${input.replyTo}`);
  }

  const transport = getTransport();
  const from = process.env['SMTP_FROM'] ?? process.env['SMTP_USER'] ?? 'noreply@honorclaw.local';

  // Detect HTML content
  const isHtml = input.body.includes('<') && input.body.includes('>');

  const info = await transport.sendMail({
    from,
    to: toList.join(', '),
    cc: ccList.length > 0 ? ccList.join(', ') : undefined,
    bcc: bccList.length > 0 ? bccList.join(', ') : undefined,
    replyTo: input.replyTo,
    subject: input.subject,
    ...(isHtml ? { html: input.body } : { text: input.body }),
  });

  return {
    success: true,
    messageId: info.messageId,
  };
}

// ── Tool entry point ────────────────────────────────────────────────────

createTool(InputSchema, sendEmail);
