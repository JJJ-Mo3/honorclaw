import { resolve4, resolve6 } from 'node:dns/promises';

const PRIVATE_RANGES_V4 = [
  { prefix: '127.', label: 'loopback' },
  { prefix: '10.', label: 'RFC 1918' },
  { prefix: '169.254.', label: 'link-local/IMDS' },
  { prefix: '0.', label: 'unspecified' },
];

function isPrivateIPv4(ip: string): boolean {
  for (const range of PRIVATE_RANGES_V4) {
    if (ip.startsWith(range.prefix)) return true;
  }
  // 172.16.0.0/12
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] ?? '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  // 192.168.0.0/16
  if (ip.startsWith('192.168.')) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

export async function validateWebhookUrl(url: string, allowHttp = false): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol check
  if (parsed.protocol === 'http:' && !allowHttp) {
    return { valid: false, reason: 'HTTPS required (set ALLOW_HTTP_WEBHOOKS=true for local dev)' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  // Resolve hostname to IP
  const hostname = parsed.hostname;

  // Direct IP check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { valid: false, reason: `Private IP address: ${hostname}` };
    }
    return { valid: true };
  }

  // DNS resolution
  try {
    const [ipv4Addrs, ipv6Addrs] = await Promise.allSettled([
      resolve4(hostname),
      resolve6(hostname),
    ]);

    const allAddrs: string[] = [];
    if (ipv4Addrs.status === 'fulfilled') allAddrs.push(...ipv4Addrs.value);
    if (ipv6Addrs.status === 'fulfilled') allAddrs.push(...ipv6Addrs.value);

    if (allAddrs.length === 0) {
      return { valid: false, reason: `DNS resolution failed for ${hostname}` };
    }

    for (const addr of allAddrs) {
      if (isPrivateIPv4(addr)) {
        return { valid: false, reason: `Hostname ${hostname} resolves to private IP: ${addr}` };
      }
      if (isPrivateIPv6(addr)) {
        return { valid: false, reason: `Hostname ${hostname} resolves to private IPv6: ${addr}` };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: `DNS resolution failed for ${hostname}` };
  }
}
