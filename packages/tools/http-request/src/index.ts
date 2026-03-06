// HonorClaw Tool: HTTP Request — outbound HTTP with SSRF protection
import { createTool, z } from '@honorclaw/tool-sdk';
import { lookup } from 'node:dns/promises';

const InputSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  timeout_ms: z.number().optional(),
});

type Input = z.infer<typeof InputSchema>;

const MAX_RESPONSE_BYTES = 100 * 1024; // 100KB

// SSRF protection: block private IP ranges
const PRIVATE_RANGES = [
  { prefix: '127.', mask: 8 },       // 127.0.0.0/8
  { prefix: '10.', mask: 8 },        // 10.0.0.0/8
  { prefix: '0.', mask: 8 },         // 0.0.0.0/8
  { prefix: '169.254.', mask: 16 },  // 169.254.0.0/16
  { prefix: '192.168.', mask: 16 },  // 192.168.0.0/16
];

function isPrivateIP(ip: string): boolean {
  // Check simple prefix-based ranges
  for (const range of PRIVATE_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }

  // Check 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
  if (ip.startsWith('172.')) {
    const parts = ip.split('.');
    const second = parseInt(parts[1] ?? '0', 10);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6 loopback and link-local
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) {
    return true;
  }

  return false;
}

async function validateUrl(urlStr: string): Promise<void> {
  const parsed = new URL(urlStr);

  // Block non-HTTP(S) protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked protocol: ${parsed.protocol} — only http: and https: are allowed`);
  }

  // Resolve hostname to IP and check
  const hostname = parsed.hostname;

  // Check if hostname is already an IP
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateIP(hostname)) {
      throw new Error(`SSRF protection: requests to private IP addresses are blocked (${hostname})`);
    }
    return;
  }

  // DNS resolution check
  try {
    const result = await lookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    for (const addr of addresses) {
      if (isPrivateIP(addr.address)) {
        throw new Error(`SSRF protection: hostname ${hostname} resolves to private IP ${addr.address}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF')) throw err;
    throw new Error(`DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

createTool(InputSchema, async (input: Input) => {
  // Validate URL for SSRF
  await validateUrl(input.url);

  const timeoutMs = input.timeout_ms ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchHeaders: Record<string, string> = {
      'User-Agent': 'HonorClaw-HTTP-Tool/1.0',
      ...(input.headers ?? {}),
    };

    const res = await fetch(input.url, {
      method: input.method,
      headers: fetchHeaders,
      body: input.body && input.method !== 'GET' && input.method !== 'HEAD' ? input.body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });

    // Read response body with size limit
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes <= MAX_RESPONSE_BYTES) {
            chunks.push(value);
          } else {
            // Only push partial last chunk
            const remaining = MAX_RESPONSE_BYTES - (totalBytes - value.byteLength);
            if (remaining > 0) {
              chunks.push(value.subarray(0, remaining));
            }
            truncated = true;
            reader.cancel();
            break;
          }
        }
      }
    }

    const bodyBuffer = new Uint8Array(
      chunks.reduce((acc, c) => acc + c.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      bodyBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const bodyText = new TextDecoder().decode(bodyBuffer);

    // Convert headers to plain object
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: res.status,
      status_text: res.statusText,
      headers: responseHeaders,
      body: bodyText,
      truncated,
      url: res.url,
    };
  } finally {
    clearTimeout(timer);
  }
});
