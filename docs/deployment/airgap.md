# Air-Gapped Deployment Guide

## Overview

HonorClaw supports deployment in air-gapped (network-isolated) environments where there is no internet access. This is common in government, defense, healthcare, and financial services environments.

The air-gap deployment uses the `honorclaw bundle` commands to create a self-contained package on a connected machine, transfer it to the isolated environment, and install everything offline.

---

## Prerequisites

### Connected Machine (for bundle creation)
- Docker installed and running
- Access to the container registries (GHCR, Docker Hub)
- `honorclaw` CLI installed
- Sufficient disk space (approximately 5-15 GB depending on options)

### Air-Gapped Machine (for installation)
- Docker and Docker Compose installed
- OR Kubernetes cluster with container runtime
- Sufficient disk space for images and data
- A mechanism to transfer files (USB drive, DVD, cross-domain solution)

---

## Step 1: Create the Bundle (Connected Machine)

### Basic Bundle

```bash
honorclaw bundle create
```

This creates a `.tar.gz` file containing:
- All HonorClaw Docker images
- Supporting images (PostgreSQL, Redis, Ollama)
- Configuration templates
- Example agent manifests
- An install script

### Bundle with Ollama Model

```bash
honorclaw bundle create --include-models --model-name llama3.2
```

This adds the specified Ollama model to the bundle, so no internet access is needed to download models in the air-gapped environment.

### Custom Output Name

```bash
honorclaw bundle create --output honorclaw-airgap-v0.1.0 --version 0.1.0
```

### Verify the Bundle

After creation, note the SHA-256 checksum displayed in the output. Record this checksum for verification after transfer.

---

## Step 2: Transfer to Air-Gapped Environment

Transfer the `.tar.gz` file to the air-gapped environment using your approved data transfer mechanism:

- USB drive or removable media
- Cross-domain solution (CDS)
- Approved file transfer system

**Important:** Also transfer the SHA-256 checksum for integrity verification after transfer.

### Verify After Transfer

```bash
# Linux
sha256sum honorclaw-airgap-*.tar.gz

# macOS
shasum -a 256 honorclaw-airgap-*.tar.gz
```

Compare the checksum with the value recorded during bundle creation.

---

## Step 3: Install (Air-Gapped Machine)

### Extract the Bundle

```bash
tar xzf honorclaw-airgap-*.tar.gz
cd honorclaw-airgap-*/
```

### Run the Installer

```bash
./install.sh
```

This will:
1. Load all Docker images into the local Docker daemon
2. Import Ollama models (if included)
3. Copy configuration templates to `/etc/honorclaw/`
4. Install the CLI to `/usr/local/bin/`

### Or Install Manually

```bash
# Load Docker images
for tarfile in images/*.tar; do
  docker load -i "$tarfile"
done

# Import Ollama models (if included)
if [ -d models ]; then
  mkdir -p ~/.ollama/models
  for model_tar in models/*.tar; do
    tar -xf "$model_tar" -C ~/.ollama/models/
  done
fi

# Copy configuration
sudo mkdir -p /etc/honorclaw
sudo cp config/* /etc/honorclaw/
```

---

## Step 4: Configure and Start

### Edit Configuration

```bash
sudo cp /etc/honorclaw/honorclaw.yaml.template /etc/honorclaw/honorclaw.yaml
sudo vi /etc/honorclaw/honorclaw.yaml
```

Key settings for air-gapped environments:

```yaml
llm:
  provider: ollama           # Use local models only
  model: llama3.2
  endpoint: http://localhost:11434

# No external egress needed
egress:
  allowedDomains: []

# Disable any features that require internet
telemetry:
  enabled: false

updates:
  checkForUpdates: false
```

### Initialize and Start

```bash
honorclaw init --tier 1
honorclaw doctor
```

---

## Step 5: Deploy Agents

Use the included example manifests:

```bash
honorclaw agent deploy manifests/general-assistant.yaml
honorclaw agent deploy manifests/code-assistant.yaml
honorclaw agent deploy manifests/rag-assistant.yaml
```

---

## Kubernetes Air-Gap Deployment

For Kubernetes environments, additional steps are needed to make images available:

### Option A: Load into containerd/CRI-O Directly

```bash
# For containerd
for tarfile in images/*.tar; do
  sudo ctr -n k8s.io images import "$tarfile"
done

# For CRI-O
for tarfile in images/*.tar; do
  sudo podman load -i "$tarfile"
done
```

### Option B: Use a Local Registry

```bash
# Start a local registry
docker run -d -p 5000:5000 --name registry registry:2

# Load and re-tag images
for tarfile in images/*.tar; do
  docker load -i "$tarfile"
done

# Re-tag for local registry
docker tag ghcr.io/honorclaw/honorclaw:latest localhost:5000/honorclaw:latest
docker tag ghcr.io/honorclaw/agent-runtime:latest localhost:5000/agent-runtime:latest

# Push to local registry
docker push localhost:5000/honorclaw:latest
docker push localhost:5000/agent-runtime:latest
```

Then update your Kubernetes manifests to reference `localhost:5000/` instead of `ghcr.io/honorclaw/`.

---

## Updating in Air-Gapped Environments

To update HonorClaw:

1. On the connected machine, create a new bundle with the updated version
2. Transfer the new bundle to the air-gapped environment
3. Run the installer again (it will update the Docker images)
4. Run the upgrade command:

```bash
honorclaw upgrade
```

---

## Troubleshooting

### Docker images not loading

```bash
# Check Docker is running
docker info

# Load images with verbose output
docker load -i images/ghcr.io_honorclaw_honorclaw_latest.tar

# Verify images are loaded
docker images | grep honorclaw
```

### Ollama model not recognized

```bash
# Verify model files are in place
ls -la ~/.ollama/models/

# Restart Ollama
docker compose restart ollama

# Test model
curl http://localhost:11434/api/tags
```

### Insufficient disk space

The full bundle with models can be 10-15 GB. Ensure sufficient space:

```bash
df -h /var/lib/docker
df -h ~/.ollama
```
