#!/bin/sh
# decant installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh -s -- 0.1.0
#
# Downloads the prebuilt decant release tarball for this platform, verifies
# its SHA256 checksum against the release's SHA256SUMS file, and installs the
# decant binary. No sudo. No macOS quarantine/Gatekeeper handling: curl/wget
# and tar never set com.apple.quarantine, so there is nothing to work around.
#
# Environment variables:
#   DECANT_VERSION          version to install, with or without a leading "v"
#                           (default: latest). A positional argument overrides
#                           this variable.
#   DECANT_INSTALL_DIR      install directory (default: $HOME/.local/bin)
#   DECANT_NO_MODIFY_PATH   set to "1" to skip editing shell rc files; the
#                           PATH export line is printed instead
#   DECANT_BASE_URL         release download base (default:
#                           https://github.com/dosu-ai/decant/releases); point
#                           it at a mirror that lays assets out the same way

set -eu

repo="dosu-ai/decant"
binary_name="decant"

err() {
  printf 'decant install: error: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'decant install: warning: %s\n' "$1" >&2
}

info() {
  printf 'decant install: %s\n' "$1"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --- 1. platform detect ------------------------------------------------------

os_name=$(uname -s)
case "$os_name" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    err "unsupported OS '$os_name'. decant publishes binaries for: decant-darwin-arm64, decant-darwin-x64, decant-linux-arm64, decant-linux-x64"
    ;;
esac

arch_name=$(uname -m)
case "$arch_name" in
  x86_64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    err "unsupported architecture '$arch_name'. decant publishes binaries for: decant-darwin-arm64, decant-darwin-x64, decant-linux-arm64, decant-linux-x64"
    ;;
esac

target="${binary_name}-${os}-${arch}"

# --- 2. version resolution ----------------------------------------------------

version_arg="${1:-}"
if [ -n "$version_arg" ]; then
  version="$version_arg"
else
  version="${DECANT_VERSION:-latest}"
fi

case "$version" in
  latest) ;;
  v*) version="${version#v}" ;;
esac

base_url="${DECANT_BASE_URL:-https://github.com/${repo}/releases}"
base_url="${base_url%/}"

if [ "$version" = "latest" ]; then
  release_base="${base_url}/latest/download"
else
  release_base="${base_url}/download/v${version}"
fi

tarball_name="${target}.tar.gz"
tarball_url="${release_base}/${tarball_name}"
sums_url="${release_base}/SHA256SUMS"

# --- 3. download + checksum verify --------------------------------------------

if need_cmd curl; then
  download() {
    curl -fsSL -o "$1" "$2"
  }
elif need_cmd wget; then
  download() {
    wget -q -O "$1" "$2"
  }
else
  err "curl or wget is required to install decant but neither was found on PATH"
fi

if ! need_cmd sha256sum && ! need_cmd shasum; then
  err "neither sha256sum nor shasum was found on PATH; cannot verify the download checksum"
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/decant-install.XXXXXXXX") || err "failed to create a temporary directory"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT TERM

tarball_path="$tmp_dir/$tarball_name"
sums_path="$tmp_dir/SHA256SUMS"

info "downloading $tarball_name (version: $version)"
download "$tarball_path" "$tarball_url" || err "failed to download $tarball_url"
download "$sums_path" "$sums_url" || err "failed to download $sums_url"

expected_hash=""
while read -r sum_hash sum_file; do
  sum_file=${sum_file#\*}
  if [ "$sum_file" = "$tarball_name" ]; then
    expected_hash="$sum_hash"
    break
  fi
done < "$sums_path"

[ -n "$expected_hash" ] || err "no SHA256SUMS entry found for $tarball_name"

# `${var%% *}` keeps everything before the first space, which is the digest in
# both tools' "<hash>  <filename>" output. Shell builtin rather than awk: one
# less command this installer needs to exist on a stranger's machine.
if need_cmd sha256sum; then
  actual_hash=$(sha256sum "$tarball_path")
  actual_hash=${actual_hash%% *}
elif need_cmd shasum; then
  actual_hash=$(shasum -a 256 "$tarball_path")
  actual_hash=${actual_hash%% *}
else
  err "neither sha256sum nor shasum was found on PATH; cannot verify the download checksum"
fi

[ "$expected_hash" = "$actual_hash" ] || err "checksum mismatch for $tarball_name: expected $expected_hash, got $actual_hash"
info "checksum verified"

# --- 4. best-effort attestation ------------------------------------------------

if need_cmd gh; then
  if gh_output=$(gh attestation verify "$tarball_path" -R "$repo" 2>&1); then
    info "attestation verified"
  else
    warn "attestation verification did not succeed for $tarball_name; continuing without it"
    printf '%s\n' "$gh_output" >&2
  fi
fi

# --- extract only the decant binary -------------------------------------------

tar -xzf "$tarball_path" -C "$tmp_dir" "$binary_name" || err "failed to extract $binary_name from $tarball_name"
[ -f "$tmp_dir/$binary_name" ] || err "$tarball_name did not contain a $binary_name binary"

# --- 5. install ----------------------------------------------------------------

install_dir="${DECANT_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir" || err "failed to create install directory $install_dir"
install -m 755 "$tmp_dir/$binary_name" "$install_dir/$binary_name" || err "failed to install $binary_name into $install_dir"
dest="$install_dir/$binary_name"
info "installed $binary_name to $dest"

# --- 6. PATH handling ------------------------------------------------------------

on_path=0
case ":$PATH:" in
  *":$install_dir:"*) on_path=1 ;;
esac

if [ "$on_path" -eq 1 ]; then
  info "$install_dir is already on PATH"
else
  path_marker="# added by decant install.sh (dosu-ai/decant)"

  shell_name=$(basename "${SHELL:-sh}")
  case "$shell_name" in
    fish) export_line="set -gx PATH \"$install_dir\" \$PATH" ;;
    *) export_line="export PATH=\"$install_dir:\$PATH\"" ;;
  esac

  if [ "${DECANT_NO_MODIFY_PATH:-}" = "1" ]; then
    info "$install_dir is not on PATH. Add it to your shell profile:"
    printf '\n  %s\n\n' "$export_line"
  else
    case "$shell_name" in
      zsh) rc_file="$HOME/.zshrc" ;;
      bash)
        case "$os" in
          darwin) rc_file="$HOME/.bash_profile" ;;
          *) rc_file="$HOME/.bashrc" ;;
        esac
        ;;
      fish) rc_file="$HOME/.config/fish/config.fish" ;;
      *) rc_file="$HOME/.profile" ;;
    esac

    if [ -f "$rc_file" ] && grep -Fq "$export_line" "$rc_file"; then
      info "$install_dir PATH entry already present in $rc_file"
    else
      rc_dir=$(dirname "$rc_file")
      mkdir -p "$rc_dir" || err "failed to create directory for $rc_file"
      printf '\n%s\n%s\n' "$path_marker" "$export_line" >> "$rc_file" || err "failed to update $rc_file"
      info "added $install_dir to PATH in $rc_file"
      info "restart your shell, or run: $export_line"
    fi
  fi
fi

# --- 7. friendly final message ----------------------------------------------------

if installed_version=$("$dest" --version 2>/dev/null); then
  info "$installed_version"
else
  info "$binary_name is installed at $dest"
fi
