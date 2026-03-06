import { promises as dns } from 'node:dns';
import { URL } from 'node:url';

// SSRF IP blocklist — hard-coded, not overridable
const BLOCKED_CIDRS = [
  // Loopback
  { prefix: '127.', description: 'loopback' },
  // RFC 1918
  { prefix: '10.', description: 'RFC 1918' },
  { prefix: '192.168.', description: 'RFC 1918' },
  // Link-local
  { prefix: '169.254.', description: 'link-local/IMDS' },
  // Docker bridge default
  { prefix: '172.17.', description: 'Docker bridge' },
];

const BLOCKED_EXACT = ['0.0.0.0', '::1'];

// RFC 1918 172.16.0.0/12 check
function isRfc1918_172(ip: string): boolean {
  if (!ip.startsWith('172.')) return false;
  const second = parseInt(ip.split('.')[1] ?? '', 10);
  return second >= 16 && second <= 31;
}

function isBlockedIp(ip: string): { blocked: boolean; reason?: string } {
  for (const cidr of BLOCKED_CIDRS) {
    if (ip.startsWith(cidr.prefix)) {
      return { blocked: true, reason: cidr.description };
    }
  }
  if (BLOCKED_EXACT.includes(ip)) {
    return { blocked: true, reason: 'blocked address' };
  }
  if (isRfc1918_172(ip)) {
    return { blocked: true, reason: 'RFC 1918' };
  }
  return { blocked: false };
}

export interface SanitizeResult {
  valid: boolean;
  sanitized: Record<string, unknown>;
  reason?: string;
}

export async function sanitizeParameters(
  params: Record<string, unknown>,
  allowedDomains: string[],
): Promise<SanitizeResult> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      // Strip null bytes
      let cleaned = value.replace(/\0/g, '');
      // Normalize Unicode to NFC
      cleaned = cleaned.normalize('NFC');

      // Check for path parameters
      if (key === 'path' || key.endsWith('_path')) {
        if (cleaned.includes('..') || cleaned.startsWith('/')) {
          if (!cleaned.startsWith('/workspace/')) {
            return { valid: false, sanitized: {}, reason: `Path parameter "${key}": traversal not allowed` };
          }
        }
      }

      // Check for URL parameters
      if (key === 'url' || key.endsWith('_url') || key === 'endpoint') {
        try {
          const url = new URL(cleaned);

          // SSRF IP blocklist — Phase 1: literal IP check
          const hostname = url.hostname;
          const literalCheck = isBlockedIp(hostname);
          if (literalCheck.blocked) {
            return { valid: false, sanitized: {}, reason: 'URL parameter blocked: target address not permitted' };
          }

          // DNS resolution + Phase 2: resolved IP check
          try {
            const { address } = await dns.lookup(hostname);
            const resolvedCheck = isBlockedIp(address);
            if (resolvedCheck.blocked) {
              return { valid: false, sanitized: {}, reason: 'URL parameter blocked: target address not permitted' };
            }
          } catch {
            return { valid: false, sanitized: {}, reason: 'URL parameter blocked: DNS resolution failed' };
          }

          // Domain allowlist check
          if (allowedDomains.length > 0) {
            const domainAllowed = allowedDomains.some(domain => {
              if (domain.startsWith('*.')) {
                return hostname.endsWith(domain.slice(1)) || hostname === domain.slice(2);
              }
              return hostname === domain;
            });
            if (!domainAllowed) {
              return { valid: false, sanitized: {}, reason: `URL parameter blocked: domain "${hostname}" not in allowlist` };
            }
          }
        } catch {
          return { valid: false, sanitized: {}, reason: 'URL parameter blocked: invalid URL' };
        }
      }

      sanitized[key] = cleaned;
    } else {
      sanitized[key] = value;
    }
  }

  return { valid: true, sanitized };
}
