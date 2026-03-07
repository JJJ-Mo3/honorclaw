import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function upgradeRoutes(app: FastifyInstance) {
  app.post('/check', async () => {
    // Read version from package.json
    let currentVersion = '0.1.0';
    try {
      const pkg = require('../../package.json') as { version: string };
      currentVersion = pkg.version;
    } catch {
      // Fall back to default version
    }

    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      upgraded: false,
    };
  });
}
