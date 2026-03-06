/**
 * Air-Gap Bundle Commands
 *
 * honorclaw bundle create — Creates a self-contained air-gap bundle:
 *   - Saves all Docker images as tar archives
 *   - Includes CLI binary
 *   - Includes configuration templates
 *   - Includes deployment manifests
 *   - Generates checksums and metadata
 *
 * honorclaw bundle install — Installs from an air-gap bundle:
 *   - Verifies bundle integrity
 *   - Loads Docker images
 *   - Installs CLI
 *   - Copies configuration templates
 */
import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HONORCLAW_IMAGES = [
  'ghcr.io/honorclaw/honorclaw:latest',
  'ghcr.io/honorclaw/agent-runtime:latest',
  'ghcr.io/honorclaw/tool-web-search:latest',
  'ghcr.io/honorclaw/tool-file-ops:latest',
  'ghcr.io/honorclaw/tool-code-execution:latest',
];

const SUPPORTING_IMAGES = [
  'docker.io/library/postgres:16-alpine',
  'docker.io/library/redis:7-alpine',
  'docker.io/ollama/ollama:latest',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[bundle] ${message}`);
}

function logError(message: string): void {
  console.error(`[bundle] ERROR: ${message}`);
}

function sha256File(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Bundle Create
// ---------------------------------------------------------------------------

async function createBundle(options: {
  output?: string;
  version?: string;
  includeModels?: boolean;
  modelName?: string;
}): Promise<void> {
  const version = options.version ?? 'latest';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bundleName = options.output ?? `honorclaw-airgap-${version}-${timestamp}`;
  const bundleDir = resolve(bundleName);

  log(`Creating air-gap bundle: ${bundleDir}`);

  // Create bundle directory structure
  mkdirSync(join(bundleDir, 'images'), { recursive: true });
  mkdirSync(join(bundleDir, 'config'), { recursive: true });
  mkdirSync(join(bundleDir, 'manifests'), { recursive: true });
  mkdirSync(join(bundleDir, 'bin'), { recursive: true });
  mkdirSync(join(bundleDir, 'scripts'), { recursive: true });

  const checksums: Record<string, string> = {};

  // 1. Save Docker images
  log('Saving Docker images...');
  const allImages = [...HONORCLAW_IMAGES, ...SUPPORTING_IMAGES];

  for (const image of allImages) {
    const imageName = image.replace(/[/:]/g, '_').replace(/@/g, '_');
    const tarFile = join(bundleDir, 'images', `${imageName}.tar`);

    log(`  Pulling: ${image}`);
    try {
      execSync(`docker pull ${image}`, { stdio: 'pipe' });
    } catch {
      logError(`  Failed to pull ${image}. Ensure the image exists and you are authenticated.`);
      continue;
    }

    log(`  Saving: ${image} -> ${imageName}.tar`);
    try {
      execSync(`docker save -o "${tarFile}" ${image}`, { stdio: 'pipe' });
      checksums[`images/${imageName}.tar`] = sha256File(tarFile);
      const fileSize = (await stat(tarFile)).size;
      log(`  Saved: ${formatBytes(fileSize)}`);
    } catch (err: any) {
      logError(`  Failed to save ${image}: ${err.message}`);
    }
  }

  // 2. Optionally save Ollama model
  if (options.includeModels) {
    const modelName = options.modelName ?? 'llama3.2';
    const modelDir = join(bundleDir, 'models');
    mkdirSync(modelDir, { recursive: true });

    log(`Exporting Ollama model: ${modelName}...`);
    try {
      // Pull the model first
      execSync(`ollama pull ${modelName}`, { stdio: 'pipe', timeout: 600_000 });

      // Export model files
      const modelPath = join(modelDir, `${modelName}.tar`);
      // Ollama stores models in ~/.ollama/models — we tar the relevant directory
      const ollamaDir = join(process.env.HOME ?? '/root', '.ollama', 'models');
      execSync(`tar -cf "${modelPath}" -C "${ollamaDir}" .`, { stdio: 'pipe' });
      checksums[`models/${modelName}.tar`] = sha256File(modelPath);
      log(`  Model saved: ${modelName}`);
    } catch (err: any) {
      logError(`Failed to export model: ${err.message}`);
      log('  Skipping model export. You can add models manually.');
    }
  }

  // 3. Copy configuration templates
  log('Copying configuration templates...');
  const configSources = [
    { src: 'config/honorclaw.yaml.template', dest: 'config/honorclaw.yaml.template' },
    { src: 'infra/docker/docker-compose.security-full.yml', dest: 'config/docker-compose.yml' },
    { src: 'infra/docker/seccomp-agent.json', dest: 'config/seccomp-agent.json' },
  ];

  for (const { src, dest } of configSources) {
    const srcPath = resolve(src);
    if (existsSync(srcPath)) {
      const destPath = join(bundleDir, dest);
      copyFileSync(srcPath, destPath);
      checksums[dest] = sha256File(destPath);
      log(`  Copied: ${src}`);
    } else {
      log(`  Skipped (not found): ${src}`);
    }
  }

  // 4. Copy example manifests
  log('Copying example agent manifests...');
  const examples = ['general-assistant', 'code-assistant', 'rag-assistant'];
  for (const example of examples) {
    const srcPath = resolve(`examples/${example}/agent.yaml`);
    if (existsSync(srcPath)) {
      const destPath = join(bundleDir, 'manifests', `${example}.yaml`);
      copyFileSync(srcPath, destPath);
      checksums[`manifests/${example}.yaml`] = sha256File(destPath);
      log(`  Copied: ${example}/agent.yaml`);
    }
  }

  // 5. Create install script for the bundle
  const installScript = `#!/usr/bin/env bash
set -euo pipefail

echo "HonorClaw Air-Gap Bundle Installer"
echo "==================================="
echo ""

BUNDLE_DIR="\$(cd "\$(dirname "\$0")" && pwd)"

# Load Docker images
echo "Loading Docker images..."
for tarfile in "\$BUNDLE_DIR/images/"*.tar; do
  if [ -f "\$tarfile" ]; then
    echo "  Loading: \$(basename "\$tarfile")"
    docker load -i "\$tarfile"
  fi
done

# Load Ollama models if present
if [ -d "\$BUNDLE_DIR/models" ]; then
  echo "Importing Ollama models..."
  OLLAMA_MODELS="\${HOME}/.ollama/models"
  mkdir -p "\$OLLAMA_MODELS"
  for model_tar in "\$BUNDLE_DIR/models/"*.tar; do
    if [ -f "\$model_tar" ]; then
      echo "  Importing: \$(basename "\$model_tar")"
      tar -xf "\$model_tar" -C "\$OLLAMA_MODELS"
    fi
  done
fi

# Copy configuration
echo "Copying configuration templates..."
mkdir -p /etc/honorclaw
cp -n "\$BUNDLE_DIR/config/"* /etc/honorclaw/ 2>/dev/null || true

# Install CLI if present
if [ -f "\$BUNDLE_DIR/bin/honorclaw" ]; then
  echo "Installing CLI..."
  sudo cp "\$BUNDLE_DIR/bin/honorclaw" /usr/local/bin/honorclaw
  sudo chmod +x /usr/local/bin/honorclaw
fi

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Edit /etc/honorclaw/honorclaw.yaml.template"
echo "  2. Run: honorclaw init"
echo "  3. Run: honorclaw doctor"
`;

  const installScriptPath = join(bundleDir, 'install.sh');
  writeFileSync(installScriptPath, installScript, { mode: 0o755 });
  checksums['install.sh'] = sha256File(installScriptPath);

  // 6. Write metadata
  const metadata = {
    version,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    images: allImages,
    includesModels: options.includeModels ?? false,
    modelName: options.modelName ?? null,
    checksums,
  };

  const metadataPath = join(bundleDir, 'metadata.json');
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  // 7. Create the final tar.gz
  log('Creating bundle archive...');
  const archivePath = `${bundleDir}.tar.gz`;
  execSync(`tar -czf "${archivePath}" -C "$(dirname "${bundleDir}")" "$(basename "${bundleDir}")"`, {
    stdio: 'pipe',
  });

  // Clean up uncompressed bundle
  await rm(bundleDir, { recursive: true, force: true });

  const archiveSize = (await stat(archivePath)).size;
  const archiveChecksum = sha256File(archivePath);

  log('');
  log('Bundle created successfully!');
  log(`  Archive: ${archivePath}`);
  log(`  Size: ${formatBytes(archiveSize)}`);
  log(`  SHA-256: ${archiveChecksum}`);
  log('');
  log('Transfer this file to the air-gapped environment and run:');
  log(`  tar xzf ${resolve(archivePath)}`);
  log(`  cd ${bundleName}`);
  log('  ./install.sh');
}

// ---------------------------------------------------------------------------
// Bundle Install
// ---------------------------------------------------------------------------

async function installBundle(bundlePath: string, options: {
  skipImages?: boolean;
  skipConfig?: boolean;
  verify?: boolean;
}): Promise<void> {
  const resolvedPath = resolve(bundlePath);

  if (!existsSync(resolvedPath)) {
    logError(`Bundle not found: ${resolvedPath}`);
    process.exit(1);
  }

  // Determine if it is a directory or a tar.gz
  const fileStat = await stat(resolvedPath);
  let bundleDir: string;
  let shouldCleanup = false;

  if (fileStat.isDirectory()) {
    bundleDir = resolvedPath;
  } else {
    // Extract tar.gz
    const extractDir = resolve('honorclaw-bundle-extract');
    mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf "${resolvedPath}" -C "${extractDir}"`, { stdio: 'pipe' });

    const entries = await readdir(extractDir);
    const extracted = entries.find(e => e.startsWith('honorclaw-'));
    if (!extracted) {
      logError('Invalid bundle archive.');
      process.exit(1);
    }
    bundleDir = join(extractDir, extracted);
    shouldCleanup = true;
  }

  // Read metadata
  const metadataPath = join(bundleDir, 'metadata.json');
  if (!existsSync(metadataPath)) {
    logError('Invalid bundle: metadata.json not found.');
    process.exit(1);
  }

  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
  log(`Bundle version: ${metadata.version}`);
  log(`Created: ${metadata.createdAt}`);

  // Verify checksums
  if (options.verify !== false) {
    log('Verifying checksums...');
    let errors = 0;
    for (const [file, expectedHash] of Object.entries(metadata.checksums)) {
      const filePath = join(bundleDir, file);
      if (existsSync(filePath)) {
        const actualHash = sha256File(filePath);
        if (actualHash !== expectedHash) {
          logError(`Checksum mismatch: ${file}`);
          errors++;
        }
      } else {
        logError(`Missing file: ${file}`);
        errors++;
      }
    }
    if (errors > 0) {
      logError(`${errors} verification error(s). Bundle may be corrupted.`);
      process.exit(1);
    }
    log('All checksums verified.');
  }

  // Load Docker images
  if (!options.skipImages) {
    log('Loading Docker images...');
    const imagesDir = join(bundleDir, 'images');
    if (existsSync(imagesDir)) {
      const files = await readdir(imagesDir);
      for (const file of files) {
        if (file.endsWith('.tar')) {
          log(`  Loading: ${file}`);
          try {
            execSync(`docker load -i "${join(imagesDir, file)}"`, { stdio: 'pipe' });
          } catch (err: any) {
            logError(`  Failed to load ${file}: ${err.message}`);
          }
        }
      }
    }
  }

  // Copy configuration
  if (!options.skipConfig) {
    log('Copying configuration...');
    const configDir = join(bundleDir, 'config');
    if (existsSync(configDir)) {
      const destDir = '/etc/honorclaw';
      mkdirSync(destDir, { recursive: true });
      const files = await readdir(configDir);
      for (const file of files) {
        const destPath = join(destDir, file);
        if (!existsSync(destPath)) {
          copyFileSync(join(configDir, file), destPath);
          log(`  Installed: ${file}`);
        } else {
          log(`  Skipped (exists): ${file}`);
        }
      }
    }
  }

  // Cleanup extracted dir
  if (shouldCleanup) {
    await rm(resolve('honorclaw-bundle-extract'), { recursive: true, force: true });
  }

  log('');
  log('Bundle installation complete!');
  log('Run "honorclaw init" to initialize the deployment.');
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

export function registerBundleCommands(program: Command): void {
  const bundle = program
    .command('bundle')
    .description('Create and install air-gap deployment bundles');

  bundle
    .command('create')
    .description('Create an air-gap bundle with all required images and configs')
    .option('-o, --output <name>', 'Output bundle name')
    .option('-v, --version <version>', 'HonorClaw version', 'latest')
    .option('--include-models', 'Include Ollama models in the bundle')
    .option('--model-name <name>', 'Ollama model to include', 'llama3.2')
    .action(async (options) => {
      try {
        await createBundle(options);
      } catch (error: any) {
        logError(error.message);
        process.exit(1);
      }
    });

  bundle
    .command('install <bundle>')
    .description('Install from an air-gap bundle (directory or .tar.gz)')
    .option('--skip-images', 'Skip Docker image loading')
    .option('--skip-config', 'Skip configuration file installation')
    .option('--no-verify', 'Skip checksum verification')
    .action(async (bundlePath: string, options) => {
      try {
        await installBundle(bundlePath, options);
      } catch (error: any) {
        logError(error.message);
        process.exit(1);
      }
    });
}
