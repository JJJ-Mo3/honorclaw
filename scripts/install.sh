#!/usr/bin/env bash
#
# HonorClaw CLI Installer
#
# Usage:
#   curl -fsSL https://honorclaw.dev/install.sh | sh
#
# Environment variables:
#   HONORCLAW_VERSION   - Version to install (default: latest)
#   HONORCLAW_INSTALL_DIR - Installation directory (default: /usr/local/bin)
#   GITHUB_TOKEN        - GitHub token for private repo access (optional)
#

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO="honorclaw/honorclaw"
INSTALL_DIR="${HONORCLAW_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="honorclaw"
TMP_DIR=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info() {
  printf "\033[0;34m[info]\033[0m %s\n" "$1"
}

success() {
  printf "\033[0;32m[ok]\033[0m %s\n" "$1"
}

error() {
  printf "\033[0;31m[error]\033[0m %s\n" "$1" >&2
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Detect OS and Architecture
# ---------------------------------------------------------------------------

detect_os() {
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux)  echo "linux" ;;
    darwin) echo "darwin" ;;
    mingw*|msys*|cygwin*) echo "windows" ;;
    *)
      error "Unsupported operating system: $os"
      exit 1
      ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)  echo "amd64" ;;
    aarch64|arm64)  echo "arm64" ;;
    *)
      error "Unsupported architecture: $arch"
      exit 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Resolve latest version
# ---------------------------------------------------------------------------

resolve_version() {
  if [ -n "${HONORCLAW_VERSION:-}" ]; then
    echo "$HONORCLAW_VERSION"
    return
  fi

  local url="https://api.github.com/repos/${REPO}/releases/latest"
  local headers=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    headers="-H \"Authorization: token ${GITHUB_TOKEN}\""
  fi

  local version
  if command -v curl >/dev/null 2>&1; then
    version=$(curl -fsSL $headers "$url" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name":\s*"([^"]+)".*/\1/')
  elif command -v wget >/dev/null 2>&1; then
    version=$(wget -qO- "$url" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name":\s*"([^"]+)".*/\1/')
  else
    error "Either curl or wget is required."
    exit 1
  fi

  if [ -z "$version" ]; then
    error "Could not determine latest version. Set HONORCLAW_VERSION manually."
    exit 1
  fi

  echo "$version"
}

# ---------------------------------------------------------------------------
# Download and verify
# ---------------------------------------------------------------------------

download_binary() {
  local version="$1"
  local os="$2"
  local arch="$3"

  local ext=""
  if [ "$os" = "windows" ]; then
    ext=".exe"
  fi

  local binary_name="${BINARY_NAME}-${os}-${arch}${ext}"
  local checksum_name="${binary_name}.sha256"

  # Strip leading 'v' from version for URL
  local ver_num="${version#v}"
  local base_url="https://github.com/${REPO}/releases/download/${version}"

  TMP_DIR="$(mktemp -d)"

  info "Downloading ${binary_name} (${version})..."

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "${TMP_DIR}/${binary_name}" "${base_url}/${binary_name}"
    curl -fsSL -o "${TMP_DIR}/${checksum_name}" "${base_url}/${checksum_name}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "${TMP_DIR}/${binary_name}" "${base_url}/${binary_name}"
    wget -q -O "${TMP_DIR}/${checksum_name}" "${base_url}/${checksum_name}"
  fi

  # Verify SHA-256 checksum
  info "Verifying SHA-256 checksum..."

  local expected_hash
  expected_hash=$(awk '{print $1}' "${TMP_DIR}/${checksum_name}")

  local actual_hash
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash=$(sha256sum "${TMP_DIR}/${binary_name}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash=$(shasum -a 256 "${TMP_DIR}/${binary_name}" | awk '{print $1}')
  else
    error "Cannot verify checksum: neither sha256sum nor shasum found."
    exit 1
  fi

  if [ "$expected_hash" != "$actual_hash" ]; then
    error "Checksum verification failed!"
    error "  Expected: ${expected_hash}"
    error "  Actual:   ${actual_hash}"
    error "The downloaded file may be corrupted or tampered with."
    exit 1
  fi

  success "Checksum verified."

  echo "${TMP_DIR}/${binary_name}"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

install_binary() {
  local binary_path="$1"
  local install_path="${INSTALL_DIR}/${BINARY_NAME}"

  info "Installing to ${install_path}..."

  # Check if we need sudo
  if [ -w "$INSTALL_DIR" ]; then
    cp "$binary_path" "$install_path"
    chmod +x "$install_path"
  else
    info "Elevated permissions required. You may be prompted for your password."
    sudo cp "$binary_path" "$install_path"
    sudo chmod +x "$install_path"
  fi

  success "Installed to ${install_path}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo "  HonorClaw CLI Installer"
  echo "  ========================"
  echo ""

  local os arch version binary_path

  os=$(detect_os)
  arch=$(detect_arch)
  info "Detected platform: ${os}/${arch}"

  version=$(resolve_version)
  info "Version: ${version}"

  binary_path=$(download_binary "$version" "$os" "$arch")
  install_binary "$binary_path"

  echo ""
  success "HonorClaw CLI installed successfully!"
  echo ""
  echo "  Get started:"
  echo "    honorclaw init"
  echo "    honorclaw doctor"
  echo ""
  echo "  Documentation: https://honorclaw.dev/docs"
  echo ""
}

main "$@"
