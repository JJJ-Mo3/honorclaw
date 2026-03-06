import type { Database } from '../db/index.js';
import type { AuditEmitter } from '../audit/emitter.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustLevel = 'first_party' | 'community' | 'custom' | 'blocked';

export interface ToolManifest {
  name: string;
  version: string;
  description?: string;
  parameters?: Record<string, unknown>;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface RegisteredTool {
  id: string;
  name: string;
  version: string;
  imageDigest: string;
  manifest: ToolManifest;
  trustLevel: TrustLevel;
  scanResult?: Record<string, unknown>;
  sbom?: Record<string, unknown>;
  deprecatedAt?: string;
  deprecationReason?: string;
  createdAt: string;
}

export interface ToolFilter {
  name?: string;
  trustLevel?: TrustLevel;
  includeDeprecated?: boolean;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private db: Database;
  private auditEmitter: AuditEmitter;

  constructor(db: Database, auditEmitter: AuditEmitter) {
    this.db = db;
    this.auditEmitter = auditEmitter;
  }

  /**
   * Register a tool: store in tools table, pin the image digest (sha256:...).
   * The image digest must be a sha256 hash — tags are not accepted.
   */
  async registerTool(
    manifest: ToolManifest,
    imageDigest: string,
    opts?: { trustLevel?: TrustLevel; scanResult?: Record<string, unknown>; sbom?: Record<string, unknown> },
  ): Promise<RegisteredTool> {
    // Validate digest format
    if (!imageDigest.startsWith('sha256:') || imageDigest.length < 71) {
      throw new Error(`Invalid image digest: must be sha256:<hex>. Got: ${imageDigest}`);
    }

    const trustLevel = opts?.trustLevel ?? 'custom';

    const result = await this.db.query(
      `INSERT INTO tools (name, version, image_digest, manifest, trust_level, scan_result, sbom)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (name, version) DO UPDATE SET
         image_digest = EXCLUDED.image_digest,
         manifest = EXCLUDED.manifest,
         trust_level = EXCLUDED.trust_level,
         scan_result = EXCLUDED.scan_result,
         sbom = EXCLUDED.sbom
       RETURNING *`,
      [
        manifest.name,
        manifest.version,
        imageDigest,
        JSON.stringify(manifest),
        trustLevel,
        opts?.scanResult ? JSON.stringify(opts.scanResult) : null,
        opts?.sbom ? JSON.stringify(opts.sbom) : null,
      ],
    );

    const row = result.rows[0];
    logger.info({ name: manifest.name, version: manifest.version, trustLevel, imageDigest }, 'Tool registered');

    return this.rowToTool(row);
  }

  /**
   * List tools with optional filtering by name and trust level.
   */
  async listTools(filter?: ToolFilter): Promise<RegisteredTool[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter?.name) {
      conditions.push(`name ILIKE $${paramIndex}`);
      params.push(`%${filter.name}%`);
      paramIndex++;
    }

    if (filter?.trustLevel) {
      conditions.push(`trust_level = $${paramIndex}`);
      params.push(filter.trustLevel);
      paramIndex++;
    }

    if (!filter?.includeDeprecated) {
      conditions.push('deprecated_at IS NULL');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.db.query(
      `SELECT * FROM tools ${where} ORDER BY name, version DESC`,
      params,
    );

    return result.rows.map((r: any) => this.rowToTool(r));
  }

  /**
   * Mark a tool version as deprecated with a reason and removal deadline.
   */
  async deprecateTool(
    name: string,
    version: string,
    reason: string,
    deadline: Date,
  ): Promise<RegisteredTool | null> {
    const result = await this.db.query(
      `UPDATE tools SET
         deprecated_at = now(),
         deprecation_reason = $1
       WHERE name = $2 AND version = $3
       RETURNING *`,
      [
        JSON.stringify({ reason, removalDeadline: deadline.toISOString() }),
        name,
        version,
      ],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const tool = this.rowToTool(result.rows[0]);

    this.auditEmitter.emit({
      workspaceId: '00000000-0000-0000-0000-000000000000',
      eventType: 'admin.action',
      actorType: 'system',
      payload: { action: 'tool.deprecated', name, version, reason, deadline: deadline.toISOString() },
    });

    logger.info({ name, version, reason, deadline: deadline.toISOString() }, 'Tool deprecated');
    return tool;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private rowToTool(row: any): RegisteredTool {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      imageDigest: row.image_digest,
      manifest: row.manifest,
      trustLevel: row.trust_level,
      scanResult: row.scan_result ?? undefined,
      sbom: row.sbom ?? undefined,
      deprecatedAt: row.deprecated_at ?? undefined,
      deprecationReason: row.deprecation_reason ?? undefined,
      createdAt: row.created_at,
    };
  }
}
