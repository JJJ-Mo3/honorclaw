import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Command } from 'commander';

const DEFAULT_CERT_DIR = './certs/redis';
const CA_KEY = 'ca.key';
const CA_CERT = 'ca.crt';
const SERVER_KEY = 'server.key';
const SERVER_CERT = 'server.crt';
const CLIENT_KEY = 'client.key';
const CLIENT_CERT = 'client.crt';

/**
 * Register certificate management CLI commands.
 *
 * honorclaw certs generate-redis  — Generate self-signed CA + server + client certs
 * honorclaw certs rotate-redis    — Zero-downtime cert rotation
 */
export function registerCertsCommands(program: Command): void {
  const certsCmd = program
    .command('certs')
    .description('Certificate management for Redis mTLS');

  // ── generate-redis ──────────────────────────────────────────────────
  certsCmd
    .command('generate-redis')
    .description('Generate self-signed CA, server, and client certificates for Redis mTLS')
    .option('--out <dir>', 'Output directory for certificates', DEFAULT_CERT_DIR)
    .option('--days <n>', 'Certificate validity in days', '365')
    .option('--cn <name>', 'Common Name for the server certificate', 'honorclaw-redis')
    .option('--clients <n>', 'Number of client certificate pairs to generate', '1')
    .action((options: Record<string, string>) => {
      const outDir = resolve(options.out!);
      const days = options.days!;
      const cn = options.cn!;
      const clientCount = Number(options.clients!) || 1;

      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      console.log(`Generating Redis mTLS certificates in: ${outDir}`);

      // 1. Generate CA key and self-signed CA certificate
      console.log('  [1/4] Generating CA key and certificate...');
      execSync(
        `openssl genrsa -out "${join(outDir, CA_KEY)}" 4096`,
        { stdio: 'pipe' },
      );
      execSync(
        `openssl req -x509 -new -nodes -key "${join(outDir, CA_KEY)}" ` +
        `-sha256 -days ${days} -out "${join(outDir, CA_CERT)}" ` +
        `-subj "/C=US/ST=CA/O=HonorClaw/CN=HonorClaw Redis CA"`,
        { stdio: 'pipe' },
      );

      // 2. Generate server key and CSR
      console.log('  [2/4] Generating server key and certificate...');
      const serverCsrPath = join(outDir, 'server.csr');
      execSync(
        `openssl genrsa -out "${join(outDir, SERVER_KEY)}" 2048`,
        { stdio: 'pipe' },
      );
      execSync(
        `openssl req -new -key "${join(outDir, SERVER_KEY)}" ` +
        `-out "${serverCsrPath}" -subj "/C=US/ST=CA/O=HonorClaw/CN=${cn}"`,
        { stdio: 'pipe' },
      );

      // 3. Sign server certificate with CA
      console.log('  [3/4] Signing server certificate with CA...');
      execSync(
        `openssl x509 -req -in "${serverCsrPath}" ` +
        `-CA "${join(outDir, CA_CERT)}" -CAkey "${join(outDir, CA_KEY)}" ` +
        `-CAcreateserial -out "${join(outDir, SERVER_CERT)}" ` +
        `-days ${days} -sha256`,
        { stdio: 'pipe' },
      );

      // 4. Generate client certificates
      console.log(`  [4/4] Generating ${clientCount} client certificate(s)...`);
      for (let i = 0; i < clientCount; i++) {
        const suffix = clientCount > 1 ? `-${i + 1}` : '';
        const clientKeyFile = `client${suffix}.key`;
        const clientCertFile = `client${suffix}.crt`;
        const clientCsrPath = join(outDir, `client${suffix}.csr`);

        execSync(
          `openssl genrsa -out "${join(outDir, clientKeyFile)}" 2048`,
          { stdio: 'pipe' },
        );
        execSync(
          `openssl req -new -key "${join(outDir, clientKeyFile)}" ` +
          `-out "${clientCsrPath}" -subj "/C=US/ST=CA/O=HonorClaw/CN=honorclaw-client${suffix}"`,
          { stdio: 'pipe' },
        );
        execSync(
          `openssl x509 -req -in "${clientCsrPath}" ` +
          `-CA "${join(outDir, CA_CERT)}" -CAkey "${join(outDir, CA_KEY)}" ` +
          `-CAcreateserial -out "${join(outDir, clientCertFile)}" ` +
          `-days ${days} -sha256`,
          { stdio: 'pipe' },
        );

        // Clean up CSR
        execSync(`rm -f "${clientCsrPath}"`, { stdio: 'pipe' });
      }

      // Clean up server CSR and serial file
      execSync(`rm -f "${serverCsrPath}" "${join(outDir, 'ca.srl')}"`, { stdio: 'pipe' });

      console.log('\nCertificates generated successfully.');
      console.log(`  CA:     ${join(outDir, CA_CERT)}`);
      console.log(`  Server: ${join(outDir, SERVER_CERT)}`);
      console.log(`  Client: ${join(outDir, CLIENT_CERT)}`);
      console.log('\nUpdate your Redis config and HonorClaw connection settings to use these certificates.');
    });

  // ── rotate-redis ────────────────────────────────────────────────────
  certsCmd
    .command('rotate-redis')
    .description('Zero-downtime Redis certificate rotation')
    .option('--cert-dir <dir>', 'Directory containing current certificates', DEFAULT_CERT_DIR)
    .option('--days <n>', 'New certificate validity in days', '365')
    .option('--backup', 'Backup existing certificates before rotation', true)
    .action((options: Record<string, string | boolean>) => {
      const certDir = resolve(options['cert-dir'] as string);
      const days = options.days as string;

      if (!existsSync(join(certDir, CA_KEY)) || !existsSync(join(certDir, CA_CERT))) {
        console.error('CA key and certificate not found. Run `honorclaw certs generate-redis` first.');
        process.exit(1);
      }

      console.log('Starting zero-downtime Redis certificate rotation...');

      // Step 1: Backup existing certs
      if (options.backup !== false) {
        const backupDir = join(certDir, `backup-${Date.now()}`);
        mkdirSync(backupDir, { recursive: true });

        for (const file of [SERVER_KEY, SERVER_CERT, CLIENT_KEY, CLIENT_CERT]) {
          const src = join(certDir, file);
          if (existsSync(src)) {
            const content = readFileSync(src);
            writeFileSync(join(backupDir, file), content);
          }
        }
        console.log(`  Backed up existing certificates to: ${backupDir}`);
      }

      // Step 2: Generate new server certificate (signed by existing CA)
      console.log('  Generating new server certificate...');
      const newServerKey = join(certDir, 'server-new.key');
      const newServerCert = join(certDir, 'server-new.crt');
      const newServerCsr = join(certDir, 'server-new.csr');

      execSync(`openssl genrsa -out "${newServerKey}" 2048`, { stdio: 'pipe' });
      execSync(
        `openssl req -new -key "${newServerKey}" -out "${newServerCsr}" ` +
        `-subj "/C=US/ST=CA/O=HonorClaw/CN=honorclaw-redis"`,
        { stdio: 'pipe' },
      );
      execSync(
        `openssl x509 -req -in "${newServerCsr}" ` +
        `-CA "${join(certDir, CA_CERT)}" -CAkey "${join(certDir, CA_KEY)}" ` +
        `-CAcreateserial -out "${newServerCert}" -days ${days} -sha256`,
        { stdio: 'pipe' },
      );
      execSync(`rm -f "${newServerCsr}" "${join(certDir, 'ca.srl')}"`, { stdio: 'pipe' });

      // Step 3: Generate new client certificate
      console.log('  Generating new client certificate...');
      const newClientKey = join(certDir, 'client-new.key');
      const newClientCert = join(certDir, 'client-new.crt');
      const newClientCsr = join(certDir, 'client-new.csr');

      execSync(`openssl genrsa -out "${newClientKey}" 2048`, { stdio: 'pipe' });
      execSync(
        `openssl req -new -key "${newClientKey}" -out "${newClientCsr}" ` +
        `-subj "/C=US/ST=CA/O=HonorClaw/CN=honorclaw-client"`,
        { stdio: 'pipe' },
      );
      execSync(
        `openssl x509 -req -in "${newClientCsr}" ` +
        `-CA "${join(certDir, CA_CERT)}" -CAkey "${join(certDir, CA_KEY)}" ` +
        `-CAcreateserial -out "${newClientCert}" -days ${days} -sha256`,
        { stdio: 'pipe' },
      );
      execSync(`rm -f "${newClientCsr}" "${join(certDir, 'ca.srl')}"`, { stdio: 'pipe' });

      // Step 4: Atomic swap — rename new certs to replace old ones
      console.log('  Swapping certificates (atomic rename)...');
      renameSync(newServerKey, join(certDir, SERVER_KEY));
      renameSync(newServerCert, join(certDir, SERVER_CERT));
      renameSync(newClientKey, join(certDir, CLIENT_KEY));
      renameSync(newClientCert, join(certDir, CLIENT_CERT));

      console.log('\nCertificate rotation complete.');
      console.log('To apply the new certificates:');
      console.log('  1. Redis will pick up the new server cert on next TLS handshake (no restart needed).');
      console.log('  2. Restart HonorClaw services to load the new client certificates.');
      console.log('  3. Verify connectivity with: honorclaw doctor');
    });
}
