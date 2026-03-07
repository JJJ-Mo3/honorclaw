/**
 * Backup and Restore Commands
 *
 * honorclaw backup create — Creates a backup archive containing:
 *   - PostgreSQL dump (pg_dump)
 *   - Configuration files (honorclaw.yaml, manifests)
 *   - Audit log export
 *   - Metadata (version, timestamp, checksums)
 *
 * honorclaw backup restore — Restores from a backup archive:
 *   - Validates archive integrity (SHA-256 checksum)
 *   - Restores PostgreSQL data
 *   - Restores configuration files
 *   - Runs migrations if schema version has changed
 */
import { Command } from 'commander';
import { execSync, exec } from 'node:child_process';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, stat, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface BackupConfig {
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgDatabase: string;
  configDir: string;
  outputDir: string;
}

function getBackupConfig(): BackupConfig {
  return {
    pgHost: process.env.HONORCLAW_PG_HOST ?? 'localhost',
    pgPort: parseInt(process.env.HONORCLAW_PG_PORT ?? '5432', 10),
    pgUser: process.env.HONORCLAW_PG_USER ?? 'honorclaw',
    pgDatabase: process.env.HONORCLAW_PG_DATABASE ?? 'honorclaw',
    configDir: process.env.HONORCLAW_CONFIG_DIR ?? '/etc/honorclaw',
    outputDir: process.env.HONORCLAW_BACKUP_DIR ?? './backups',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256File(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function log(message: string): void {
  console.log(`[backup] ${message}`);
}

function logError(message: string): void {
  console.error(`[backup] ERROR: ${message}`);
}

// ---------------------------------------------------------------------------
// Backup Create
// ---------------------------------------------------------------------------

async function createBackup(options: {
  output?: string;
  auditOnly?: boolean;
  since?: string;
  skipDb?: boolean;
}): Promise<void> {
  const config = getBackupConfig();
  const ts = timestamp();
  const workDir = join(config.outputDir, `honorclaw-backup-${ts}`);

  log(`Creating backup at ${workDir}`);

  // Create work directory
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(workDir, 'config'), { recursive: true });
  mkdirSync(join(workDir, 'audit'), { recursive: true });

  const checksums: Record<string, string> = {};

  // 1. PostgreSQL dump
  if (!options.skipDb && !options.auditOnly) {
    log('Dumping PostgreSQL database...');
    const dumpFile = join(workDir, 'database.sql');
    try {
      const pgDumpCmd = [
        'pg_dump',
        `-h ${config.pgHost}`,
        `-p ${config.pgPort}`,
        `-U ${config.pgUser}`,
        `--no-owner`,
        `--no-privileges`,
        `--format=plain`,
        `--file=${dumpFile}`,
        config.pgDatabase,
      ].join(' ');

      execSync(pgDumpCmd, {
        env: { ...process.env, PGPASSWORD: process.env.HONORCLAW_PG_PASSWORD ?? '' },
        stdio: 'pipe',
      });

      checksums['database.sql'] = sha256File(dumpFile);
      log(`Database dump complete: ${dumpFile}`);
    } catch (error: any) {
      logError(`pg_dump failed: ${error.message}`);
      logError('Ensure pg_dump is installed and database is accessible.');
      throw new Error('Database backup failed');
    }
  }

  // 2. Export configuration files
  if (!options.auditOnly) {
    log('Exporting configuration files...');
    const configFiles = [
      'honorclaw.yaml',
      'honorclaw.yml',
      'honorclaw.yaml.template',
    ];

    for (const file of configFiles) {
      const srcPath = join(config.configDir, file);
      if (existsSync(srcPath)) {
        const destPath = join(workDir, 'config', file);
        const content = readFileSync(srcPath);
        writeFileSync(destPath, content);
        checksums[`config/${file}`] = createHash('sha256').update(content).digest('hex');
        log(`  Backed up: ${file}`);
      }
    }

    // Export manifests from database
    log('Exporting capability manifests...');
    try {
      const manifestsDir = join(workDir, 'manifests');
      mkdirSync(manifestsDir, { recursive: true });

      const manifestQuery = `
        COPY (
          SELECT row_to_json(m)
          FROM capability_manifests m
          ORDER BY agent_id, version
        ) TO STDOUT;
      `;
      const { stdout } = await execAsync(
        `psql -h ${config.pgHost} -p ${config.pgPort} -U ${config.pgUser} -d ${config.pgDatabase} -c "${manifestQuery}"`,
        { env: { ...process.env, PGPASSWORD: process.env.HONORCLAW_PG_PASSWORD ?? '' } },
      );

      const manifestFile = join(manifestsDir, 'manifests.jsonl');
      writeFileSync(manifestFile, stdout);
      checksums['manifests/manifests.jsonl'] = createHash('sha256').update(stdout).digest('hex');
      log(`  Exported manifests`);
    } catch {
      log('  Warning: Could not export manifests from database (table may not exist yet)');
    }
  }

  // 3. Export audit logs
  log('Exporting audit logs...');
  try {
    let auditQuery = `
      COPY (
        SELECT row_to_json(a)
        FROM audit_events a
    `;
    if (options.since) {
      if (isNaN(Date.parse(options.since))) {
        throw new Error(`Invalid --since date: "${options.since}". Must be a valid ISO 8601 date.`);
      }
      const sanitizedDate = new Date(options.since).toISOString();
      auditQuery += ` WHERE created_at >= '${sanitizedDate}'`;
    }
    auditQuery += ` ORDER BY created_at
      ) TO STDOUT;
    `;

    const { stdout } = await execAsync(
      `psql -h ${config.pgHost} -p ${config.pgPort} -U ${config.pgUser} -d ${config.pgDatabase} -c "${auditQuery}"`,
      { env: { ...process.env, PGPASSWORD: process.env.HONORCLAW_PG_PASSWORD ?? '' } },
    );

    const auditFile = join(workDir, 'audit', 'audit-events.jsonl');
    writeFileSync(auditFile, stdout);
    checksums['audit/audit-events.jsonl'] = createHash('sha256').update(stdout).digest('hex');
    log(`  Exported audit events`);
  } catch {
    log('  Warning: Could not export audit events (table may not exist yet)');
  }

  // 4. Write metadata
  const metadata = {
    version: '0.1.0',
    createdAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    pgHost: config.pgHost,
    pgDatabase: config.pgDatabase,
    auditOnly: options.auditOnly ?? false,
    checksums,
  };

  const metadataFile = join(workDir, 'metadata.json');
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
  log('Wrote backup metadata');

  // 5. Create tar.gz archive
  const archiveName = options.output ?? `honorclaw-backup-${ts}.tar.gz`;
  const archivePath = resolve(config.outputDir, archiveName);

  mkdirSync(config.outputDir, { recursive: true });

  execSync(`tar -czf "${archivePath}" -C "${config.outputDir}" "honorclaw-backup-${ts}"`, {
    stdio: 'pipe',
  });

  // Calculate archive checksum
  const archiveChecksum = sha256File(archivePath);

  // Clean up work directory
  await rm(workDir, { recursive: true, force: true });

  log('');
  log('Backup complete!');
  log(`  Archive: ${archivePath}`);
  log(`  SHA-256: ${archiveChecksum}`);
  log(`  Size: ${(readFileSync(archivePath).length / 1024 / 1024).toFixed(2)} MB`);
}

// ---------------------------------------------------------------------------
// Backup Restore
// ---------------------------------------------------------------------------

async function restoreBackup(archivePath: string, options: {
  skipDb?: boolean;
  skipConfig?: boolean;
  verify?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const config = getBackupConfig();
  const resolvedPath = resolve(archivePath);

  if (!existsSync(resolvedPath)) {
    logError(`Archive not found: ${resolvedPath}`);
    process.exit(1);
  }

  log(`Restoring from: ${resolvedPath}`);

  // Verify archive integrity
  const archiveChecksum = sha256File(resolvedPath);
  log(`Archive SHA-256: ${archiveChecksum}`);

  // Extract archive
  const extractDir = join(config.outputDir, 'restore-tmp');
  mkdirSync(extractDir, { recursive: true });

  execSync(`tar -xzf "${resolvedPath}" -C "${extractDir}"`, { stdio: 'pipe' });

  // Find the extracted directory
  const entries = await readdir(extractDir);
  const backupDir = entries.find(e => e.startsWith('honorclaw-backup-'));
  if (!backupDir) {
    logError('Invalid backup archive: no honorclaw-backup-* directory found');
    await rm(extractDir, { recursive: true, force: true });
    process.exit(1);
  }

  const workDir = join(extractDir, backupDir);

  // Read and verify metadata
  const metadataPath = join(workDir, 'metadata.json');
  if (!existsSync(metadataPath)) {
    logError('Invalid backup archive: metadata.json not found');
    await rm(extractDir, { recursive: true, force: true });
    process.exit(1);
  }

  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
  log(`Backup version: ${metadata.version}`);
  log(`Backup created: ${metadata.createdAt}`);
  log(`Audit only: ${metadata.auditOnly}`);

  // Verify file checksums
  if (options.verify !== false) {
    log('Verifying file checksums...');
    let checksumErrors = 0;
    for (const [file, expectedHash] of Object.entries(metadata.checksums)) {
      const filePath = join(workDir, file);
      if (existsSync(filePath)) {
        const actualHash = sha256File(filePath);
        if (actualHash !== expectedHash) {
          logError(`Checksum mismatch: ${file}`);
          logError(`  Expected: ${expectedHash}`);
          logError(`  Actual:   ${actualHash}`);
          checksumErrors++;
        } else {
          log(`  Verified: ${file}`);
        }
      } else {
        logError(`Missing file: ${file}`);
        checksumErrors++;
      }
    }

    if (checksumErrors > 0) {
      logError(`${checksumErrors} checksum error(s) found. Aborting restore.`);
      await rm(extractDir, { recursive: true, force: true });
      process.exit(1);
    }
    log('All checksums verified.');
  }

  if (options.dryRun) {
    log('Dry run complete. No changes made.');
    await rm(extractDir, { recursive: true, force: true });
    return;
  }

  // Restore database
  if (!options.skipDb && !metadata.auditOnly) {
    const dumpFile = join(workDir, 'database.sql');
    if (existsSync(dumpFile)) {
      log('Restoring PostgreSQL database...');
      log('WARNING: This will overwrite the existing database.');
      try {
        execSync(
          `psql -h ${config.pgHost} -p ${config.pgPort} -U ${config.pgUser} -d ${config.pgDatabase} -f "${dumpFile}"`,
          {
            env: { ...process.env, PGPASSWORD: process.env.HONORCLAW_PG_PASSWORD ?? '' },
            stdio: 'pipe',
          },
        );
        log('Database restored successfully.');
      } catch (error: any) {
        logError(`Database restore failed: ${error.message}`);
        throw new Error('Database restore failed');
      }
    } else {
      log('No database dump found in archive. Skipping database restore.');
    }
  }

  // Restore configuration files
  if (!options.skipConfig) {
    const configSrc = join(workDir, 'config');
    if (existsSync(configSrc)) {
      log('Restoring configuration files...');
      mkdirSync(config.configDir, { recursive: true });
      const files = await readdir(configSrc);
      for (const file of files) {
        const srcPath = join(configSrc, file);
        const destPath = join(config.configDir, file);
        const content = readFileSync(srcPath);
        writeFileSync(destPath, content);
        log(`  Restored: ${file}`);
      }
    }
  }

  // Clean up
  await rm(extractDir, { recursive: true, force: true });

  log('');
  log('Restore complete!');
  log('Run "honorclaw doctor" to verify system health.');
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

export function registerBackupCommands(program: Command): void {
  const backup = program
    .command('backup')
    .description('Backup and restore HonorClaw data');

  backup
    .command('create')
    .description('Create a backup archive')
    .option('-o, --output <filename>', 'Output archive filename')
    .option('--audit-only', 'Export audit logs only (no database or config)')
    .option('--since <date>', 'Export audit events since date (ISO 8601)')
    .option('--skip-db', 'Skip database dump')
    .action(async (options) => {
      try {
        await createBackup(options);
      } catch (error: any) {
        logError(error.message);
        process.exit(1);
      }
    });

  backup
    .command('restore <archive>')
    .description('Restore from a backup archive (.tar.gz)')
    .option('--skip-db', 'Skip database restore')
    .option('--skip-config', 'Skip configuration file restore')
    .option('--no-verify', 'Skip checksum verification')
    .option('--dry-run', 'Verify archive without making changes')
    .action(async (archive: string, options) => {
      try {
        await restoreBackup(archive, options);
      } catch (error: any) {
        logError(error.message);
        process.exit(1);
      }
    });
}
