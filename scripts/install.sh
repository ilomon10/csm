#!/bin/sh
# csm installer for Linux and macOS.
#   curl -fsSL https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/ilomon10/csm/main/scripts/install.sh | sh -s -- --uninstall [--purge]
# Env: CSM_VERSION, CSM_INSTALL_DIR, CSM_DOWNLOAD_BASE (replaces the release download URL; skips the API lookup;
#      must be https:// or a local absolute file:///path).
# Downloads are HTTPS only. GNU wget gets --secure-protocol=TLSv1_2. BusyBox wget has neither that flag nor
# --https-only, so it is used with plain "wget -q -O" and only ever sees https:// URLs (checked before every call).
set -eu

REPO="ilomon10/csm"
TMPDIR_CSM=""

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$TMPDIR_CSM" ] && [ -d "$TMPDIR_CSM" ]; then
    rm -rf "$TMPDIR_CSM"
  fi
}

usage() {
  cat <<'USAGE'
csm installer

Usage: install.sh [--version X] [--no-setup] [--allow-root] [--uninstall [--purge]] [--help]

  --version X   install version X (0.1.0-beta.1 or v0.1.0-beta.1); default: latest release, prereleases included
  --no-setup    do not run "csm setup --yes" (shell rc block)
  --allow-root  permit running as root (refused by default; csm is a per-user tool)
  --uninstall   run "csm uninstall --yes" and remove the binary
  --purge       with --uninstall: also delete all csm data (CSM_HOME, every login)
  --help        show this help

Environment: CSM_VERSION, CSM_INSTALL_DIR (default ~/.local/bin), CSM_DOWNLOAD_BASE (https:// or file:///path)
USAGE
}

have() { command -v "$1" >/dev/null 2>&1; }

# is_busybox_wget : true when the wget on PATH is BusyBox's (no --secure-protocol / --header config support)
is_busybox_wget() {
  wget --help 2>&1 | grep -qi busybox
}

# require_https <url> : every network URL must be https://
require_https() {
  case "$1" in
    https://*) ;;
    *) die "refusing non-HTTPS URL: $1" ;;
  esac
}

# fetch <url> <outfile> ; file:/// bases are copied, https:// URLs use curl then wget.
fetch() {
  _url=$1
  _out=$2
  case "$_url" in
    file:///*)
      cp "${_url#file://}" "$_out" 2>/dev/null || return 1
      ;;
    https://*)
      if have curl; then
        curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$_out" "$_url" || return 1
      elif have wget; then
        if is_busybox_wget; then
          wget -q -O "$_out" "$_url" || return 1
        else
          wget -q --secure-protocol=TLSv1_2 -O "$_out" "$_url" || return 1
        fi
      else
        die "neither curl nor wget found; install one of them and retry"
      fi
      ;;
    *)
      die "refusing non-HTTPS URL: $_url"
      ;;
  esac
}

# api_get <url> : print body to stdout. The token (if any) is sent only to api.github.com and never
# appears on a command line: curl reads it from a stdin config, wget from a 0600 wgetrc in the temp dir.
api_get() {
  _url=$1
  require_https "$_url"
  _tok=${GITHUB_TOKEN:-}
  if [ -n "$_tok" ]; then
    case "$_tok" in
      *[!A-Za-z0-9_.-]*) warn "GITHUB_TOKEN contains unexpected characters; ignoring it"; _tok="" ;;
    esac
  fi
  if have curl; then
    if [ -n "$_tok" ]; then
      printf 'header = "Authorization: Bearer %s"\n' "$_tok" \
        | curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --config - -H "Accept: application/vnd.github+json" "$_url"
    else
      curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -H "Accept: application/vnd.github+json" "$_url"
    fi
  elif have wget; then
    if is_busybox_wget; then
      [ -z "$_tok" ] || warn "BusyBox wget cannot take the token off the command line; ignoring GITHUB_TOKEN (install curl to use it)"
      wget -q -O - "$_url"
    elif [ -n "$_tok" ]; then
      _rc="$TMPDIR_CSM/wgetrc"
      ( umask 077; printf 'header = Authorization: Bearer %s\n' "$_tok" > "$_rc" )
      wget -q --secure-protocol=TLSv1_2 --config="$_rc" -O - --header="Accept: application/vnd.github+json" "$_url"
    else
      wget -q --secure-protocol=TLSv1_2 -O - --header="Accept: application/vnd.github+json" "$_url"
    fi
  else
    die "neither curl nor wget found; install one of them and retry"
  fi
}

# valid_version <v> : semver-ish, optional leading v, single line only
valid_version() {
  case "$1" in
    *'
'*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

detect_target() {
  _os=$(uname -s)
  _m=$(uname -m)
  case "$_os" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "unsupported OS '$_os'. On Windows use install.ps1; otherwise install with npm (see https://github.com/$REPO#install)" ;;
  esac
  case "$_m" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported CPU architecture '$_m' (need x86_64 or arm64)" ;;
  esac
  if [ "$OS" = darwin ] && [ "$ARCH" = x64 ]; then
    # Rosetta: an x64 shell on Apple Silicon should still get the native binary.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
      ARCH=arm64
    fi
  fi
  if [ "$OS" = linux ]; then
    if [ -f /etc/alpine-release ] || { have ldd && ldd --version 2>&1 | grep -qi musl; }; then
      # The tag is only known here when --version/CSM_VERSION was given (detect_target runs before the lookup).
      if [ -n "${WANT_VERSION:-}" ] && valid_version "$WANT_VERSION"; then
        _t=${WANT_VERSION#v}
        die "musl libc detected (e.g. Alpine): there is no musl build yet. Use npm instead: npm i -g https://github.com/$REPO/releases/download/v$_t/claude-session-manager-$_t.tgz (see https://github.com/$REPO#install)"
      fi
      die "musl libc detected (e.g. Alpine): there is no musl build yet. Use npm instead (see https://github.com/$REPO#install for the tarball)"
    fi
  fi
}

resolve_tag() {
  if [ -n "$WANT_VERSION" ]; then
    valid_version "$WANT_VERSION" || die "invalid version '$WANT_VERSION' (expected e.g. 0.1.0 or v0.1.0-beta.1)"
    case "$WANT_VERSION" in
      v*) TAG=$WANT_VERSION ;;
      *) TAG="v$WANT_VERSION" ;;
    esac
    return 0
  fi
  if [ -n "${CSM_DOWNLOAD_BASE:-}" ]; then
    die "CSM_DOWNLOAD_BASE is set, so the version cannot be looked up; pass --version X or set CSM_VERSION"
  fi
  say "Looking up the latest release..."
  _json=$(api_get "https://api.github.com/repos/$REPO/releases?per_page=10") \
    || die "could not query the GitHub releases API (rate limit or network?). Pass --version X, or set GITHUB_TOKEN"
  # First non-draft release: tag_name precedes draft in each release object.
  TAG=$(printf '%s' "$_json" | tr ',' '\n' | grep -E '"(tag_name|draft)"' \
    | sed -E 's/.*"(tag_name|draft)"[[:space:]]*:[[:space:]]*"?([^",}]*)"?.*/\1 \2/' \
    | awk '$1=="tag_name"{t=$2} $1=="draft"&&$2=="false"{print t; exit}')
  [ -n "$TAG" ] || die "no published release found for $REPO. Pass --version X to choose one"
  valid_version "$TAG" || die "the releases API returned an invalid tag '$TAG'; pass --version X"
}

sha_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum found; cannot verify the download, refusing to install"
  fi
}

do_install() {
  detect_target
  TMPDIR_CSM=$(mktemp -d "${TMPDIR:-/tmp}/csm-install.XXXXXX") || die "could not create a temp directory"
  resolve_tag
  VER=${TAG#v}
  ASSET="csm-$OS-$ARCH"
  BASE=${CSM_DOWNLOAD_BASE:-"https://github.com/$REPO/releases/download/$TAG"}
  BASE=${BASE%/}
  case "$BASE" in
    https://*|file:///*) ;;
    *) die "CSM_DOWNLOAD_BASE must start with https:// or file:/// (got '$BASE')" ;;
  esac

  say "Downloading $ASSET ($TAG)..."
  fetch "$BASE/$ASSET" "$TMPDIR_CSM/$ASSET" || die "download failed: $BASE/$ASSET (does release $TAG exist for $OS-$ARCH?)"
  fetch "$BASE/SHA256SUMS" "$TMPDIR_CSM/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"

  want=$(awk -v a="$ASSET" '$2==a || $2=="*"a {print $1; exit}' "$TMPDIR_CSM/SHA256SUMS")
  [ -n "$want" ] || die "SHA256SUMS has no entry for $ASSET; refusing to install"
  got=$(sha_of "$TMPDIR_CSM/$ASSET")
  if [ "$want" != "$got" ]; then
    die "checksum mismatch for $ASSET (expected $want, got $got); the download is corrupt or tampered with. Nothing was installed"
  fi
  say "Checksum OK."

  INSTALL_DIR=${CSM_INSTALL_DIR:-"$HOME/.local/bin"}
  DEST="$INSTALL_DIR/csm"
  if [ ! -d "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR (set CSM_INSTALL_DIR to a writable directory)"
    # Remember that we made it, so --uninstall may remove it again (and never a pre-existing directory).
    : > "$INSTALL_DIR/.csm-installer-created" 2>/dev/null || true
  fi
  STAGE=$(mktemp "$INSTALL_DIR/.csm.tmp.XXXXXX") || die "could not write to $INSTALL_DIR (set CSM_INSTALL_DIR to a writable directory)"
  cp "$TMPDIR_CSM/$ASSET" "$STAGE" || { rm -f "$STAGE"; die "could not write to $INSTALL_DIR"; }
  chmod 755 "$STAGE" || { rm -f "$STAGE"; die "chmod failed on $STAGE"; }
  mv -f "$STAGE" "$DEST" || { rm -f "$STAGE"; die "could not move the binary to $DEST"; }

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      warn "$INSTALL_DIR is not on your PATH. Add this line to your shell rc file:"
      say "  export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac

  if [ "$DO_SETUP" = 1 ]; then
    if ! "$DEST" setup --yes </dev/null; then
      warn "\"csm setup\" failed; run it yourself later: $DEST setup --yes"
    fi
  fi

  say "csm $VER installed to $DEST"
  say "Next: csm add <name>"
}

do_uninstall() {
  INSTALL_DIR=${CSM_INSTALL_DIR:-"$HOME/.local/bin"}
  DEST="$INSTALL_DIR/csm"
  if [ -e "$DEST" ]; then
    if [ "$PURGE" = 1 ]; then
      "$DEST" uninstall --yes --purge </dev/null || die "\"csm uninstall --purge\" failed; the binary was left in place at $DEST"
    else
      "$DEST" uninstall --yes </dev/null || die "\"csm uninstall\" failed; the binary was left in place at $DEST"
    fi
    rm -f "$DEST" || die "could not remove $DEST"
    # Only remove the directory if this installer created it and nothing else lives in it.
    if [ -f "$INSTALL_DIR/.csm-installer-created" ]; then
      rm -f "$INSTALL_DIR/.csm-installer-created"
      rmdir "$INSTALL_DIR" 2>/dev/null || : > "$INSTALL_DIR/.csm-installer-created" 2>/dev/null || true
    fi
    say "csm removed from $DEST"
  else
    warn "csm binary not found at $DEST; rc blocks not removed"
  fi
}

main() {
  WANT_VERSION=${CSM_VERSION:-}
  DO_SETUP=1
  UNINSTALL=0
  PURGE=0
  ALLOW_ROOT=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || die "--version needs a value"
        WANT_VERSION=$2
        shift
        ;;
      --version=*) WANT_VERSION=${1#--version=} ;;
      --no-setup) DO_SETUP=0 ;;
      --allow-root) ALLOW_ROOT=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      -h|--help) usage; return 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
  if [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ]; then
    die "--purge only works together with --uninstall"
  fi
  [ -n "${HOME:-}" ] || die "HOME is not set"
  if [ "$(id -u)" = 0 ] && [ "$ALLOW_ROOT" != 1 ]; then
    die "refusing to run as root: csm is a per-user tool. Re-run as a normal user, or pass --allow-root"
  fi

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
  else
    do_install
  fi
}

main "$@"
