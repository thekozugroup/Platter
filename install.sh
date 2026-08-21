#!/bin/sh
#
# Platter installer.
#
#   curl -fsSL https://raw.githubusercontent.com/thekozugroup/Platter/main/install.sh | sh
#
# You are about to pipe a script off the internet into a shell, so this one is written to be
# read first. It is POSIX sh, it has no dependencies beyond Docker and curl-or-wget, and every
# line below does one of five things:
#
#   1. Checks that this machine can actually run Platter, and says how to fix it when it cannot.
#   2. Generates a JWT signing secret and works out two values people usually get wrong —
#      the GID that owns the Docker socket, and this host's address on the network.
#   3. Writes `.env` and `docker-compose.yml` into a directory you choose.
#   4. Runs `docker compose up -d` and waits for the health endpoint to answer.
#   5. Prints the URL.
#
# It never runs as root by itself, never installs a package, never writes outside the target
# directory, and never touches an existing `.env`. Running it a second time upgrades the
# install in place: your secret, your data volume and your settings are left alone.
#
# The one thing worth pausing on is that the compose file mounts `/var/run/docker.sock`.
# Platter manages game servers as sibling containers, so it needs the daemon — and anything
# that can write to that socket can start a container that mounts the host filesystem. That is
# equivalent to root on this machine. It is the same trade every self-hosted Docker panel
# makes, and it is why you should read `docs/DEPLOYMENT.md` before putting one on the internet.
#
# MIT © The Kozu Group

set -eu

# ---------------------------------------------------------------------------
# Defaults. Every one is overridable by environment variable or flag.
# ---------------------------------------------------------------------------

PLATTER_DIR="${PLATTER_DIR:-./platter}"
PLATTER_PORT="${PLATTER_PORT:-8080}"
PLATTER_IMAGE="${PLATTER_IMAGE:-ghcr.io/thekozugroup/platter:latest}"
PLATTER_PUBLIC_HOST="${PLATTER_PUBLIC_HOST:-}"
# Which host interface the web interface is published on. 0.0.0.0 keeps the default that
# every self-hosted panel has — reachable from the LAN, which is the point. It is settable
# because "reachable" and "reachable from the whole internet" are not the same wish, and a
# host with a public interface makes them differ sharply: first-run setup is unauthenticated
# by construction, so whoever reaches a fresh instance first owns it.
PLATTER_BIND="${PLATTER_BIND:-0.0.0.0}"

CONTAINER_NAME=platter
READY_PATH=/api/v1/system/ready
READY_TIMEOUT=180

# Enough for the image (~900 MB) and a little room. Game server worlds land in the Docker
# volume and dwarf this, hence the separate, larger advisory threshold.
DISK_REQUIRED_MB=2048
DISK_COMFORTABLE_MB=10240

ASSUME_YES=no

# ---------------------------------------------------------------------------
# Output. Colour only when a terminal is actually attached.
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m')
  D=$(printf '\033[2m')
  R=$(printf '\033[0m')
  RED=$(printf '\033[31m')
  YEL=$(printf '\033[33m')
  GRN=$(printf '\033[32m')
else
  B='' D='' R='' RED='' YEL='' GRN=''
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$B" "$R" "$*"; }
info() { printf '    %s\n' "$*"; }
note() { printf '    %s%s%s\n' "$D" "$*" "$R"; }
warn() { printf '%swarning:%s %s\n' "$YEL" "$R" "$*" >&2; }

# Failures print the problem and then the fix, because "port 8080 is in use" on its own has
# never helped anybody.
die() {
  printf '\n%serror:%s %s\n' "$RED" "$R" "$1" >&2
  shift
  for _line in "$@"; do printf '       %s\n' "$_line" >&2; done
  printf '\n' >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Reading input when stdin is the script itself.
#
# Under `curl … | sh` stdin is the pipe carrying this file, so `read` would consume the
# script's own remaining bytes. Every prompt therefore goes to /dev/tty, and when there is no
# tty (CI, a container build) the script takes the default and says so rather than hanging.
# ---------------------------------------------------------------------------

# Note the shape of the probe. `[ -r /dev/tty ]` is *not* enough: the device node exists and
# is mode 666 on a machine with no controlling terminal, so the permission test passes and the
# first write then fails with ENXIO. The only reliable check is to open it. That happens inside
# a subshell because a redirection failure on a special builtin such as `exec` is required by
# POSIX to abort the shell — in a subshell it aborts only the subshell.
TTY=''
if (exec 3>/dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# ask <question> <default> -> answer on stdout
ask() {
  _q=$1
  _d=$2
  if [ -z "$TTY" ] || [ "$ASSUME_YES" = yes ]; then
    printf '%s\n' "$_d"
    return 0
  fi
  printf '%s [%s]: ' "$_q" "$_d" >"$TTY"
  IFS= read -r _a <"$TTY" || _a=''
  [ -n "$_a" ] || _a=$_d
  printf '%s\n' "$_a"
}

# confirm <question> -> 0 for yes. Defaults to yes; a missing tty is treated as yes, because
# piping this script into a shell is itself the consent.
confirm() {
  [ "$ASSUME_YES" = yes ] && return 0
  [ -z "$TTY" ] && return 0
  printf '%s [Y/n]: ' "$1" >"$TTY"
  IFS= read -r _a <"$TTY" || _a=''
  case "$_a" in
  '' | y | Y | yes | YES | Yes) return 0 ;;
  *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Platter installer — self-hosted control panel for game servers.

USAGE
  install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/thekozugroup/Platter/main/install.sh | sh

WHAT IT DOES
  Writes .env and docker-compose.yml into a directory (default ./platter), starts one
  container and one volume, and waits for the panel to answer. Running it again upgrades
  that install in place and never rewrites .env.

OPTIONS
  -d, --dir PATH         Install directory              (default: ./platter)
  -p, --port PORT        Port for the web interface     (default: 8080)
  -i, --image REF        Container image to run         (default: ghcr.io/thekozugroup/platter:latest)
  -b, --bind ADDRESS     Interface to publish the web interface on
                         (default: 0.0.0.0, all interfaces)
  -H, --public-host HOST Address players use to reach game servers
                         (default: this host's address on its default route)
  -y, --yes              Take every default; never prompt
  -h, --help             This text

ENVIRONMENT
  PLATTER_DIR, PLATTER_PORT, PLATTER_IMAGE, PLATTER_PUBLIC_HOST, PLATTER_BIND
      Same as the flags above. Flags win.
  NO_COLOR
      Set to disable colour.

AFTER INSTALLING
  Open the URL it prints and create the first account. That account owns the installation;
  there is no default password to change and no account is created for you.

  Manage it with docker compose from the install directory:
      docker compose logs -f      docker compose restart
      docker compose pull         docker compose down

REQUIREMENTS
  Docker with a reachable daemon, the compose plugin, and curl or wget.

  The compose file mounts /var/run/docker.sock. That is equivalent to root on this host.
  Read docs/DEPLOYMENT.md before exposing an instance to the internet.

  https://github.com/thekozugroup/Platter
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  -d | --dir)
    [ $# -ge 2 ] || die "--dir needs a path." "Example: --dir /opt/platter"
    PLATTER_DIR=$2
    shift 2
    ;;
  -p | --port)
    [ $# -ge 2 ] || die "--port needs a number." "Example: --port 9000"
    PLATTER_PORT=$2
    shift 2
    ;;
  -i | --image)
    [ $# -ge 2 ] || die "--image needs a reference." "Example: --image ghcr.io/thekozugroup/platter:0.1.0"
    PLATTER_IMAGE=$2
    shift 2
    ;;
  -b | --bind)
    [ $# -ge 2 ] || die "--bind needs an address." "Example: --bind 127.0.0.1"
    PLATTER_BIND=$2
    shift 2
    ;;
  -H | --public-host)
    [ $# -ge 2 ] || die "--public-host needs a hostname or address." "Example: --public-host play.example.com"
    PLATTER_PUBLIC_HOST=$2
    shift 2
    ;;
  -y | --yes)
    ASSUME_YES=yes
    shift
    ;;
  *)
    die "Unknown option: $1" "Run 'install.sh --help' for the list."
    ;;
  esac
done

case "$PLATTER_PORT" in
'' | *[!0-9]*) die "Port must be a number, got '$PLATTER_PORT'." "Example: --port 8080" ;;
esac
if [ "$PLATTER_PORT" -lt 1 ] || [ "$PLATTER_PORT" -gt 65535 ]; then
  die "Port must be between 1 and 65535, got '$PLATTER_PORT'."
fi

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# One HTTP probe, whichever client this machine has. Used only against 127.0.0.1.
http_ok() {
  if have curl; then
    curl -fsS -m 5 "$1" >/dev/null 2>&1
  elif have wget; then
    wget -q -T 5 -O /dev/null "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight() {
  step "Checking this machine"

  if ! have docker; then
    die "Docker is not installed." \
      "Install it, then run this again:" \
      "  Linux         curl -fsSL https://get.docker.com | sh" \
      "  macOS/Windows https://docs.docker.com/desktop/" \
      "  Debian/Ubuntu https://docs.docker.com/engine/install/"
  fi
  info "docker            $(docker --version 2>/dev/null | sed 's/,.*//')"

  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but its daemon is not reachable." \
      "Start it and check you may talk to it:" \
      "  sudo systemctl start docker      # systemd hosts" \
      "  open -a Docker                   # macOS, Docker Desktop" \
      "If it is running, your user is probably not in the 'docker' group:" \
      "  sudo usermod -aG docker \"\$USER\"   # then log out and back in" \
      "Verify with: docker info"
  fi
  info "daemon            reachable"

  # Compose v2 is the plugin; v1 is the standalone binary, EOL but still on plenty of hosts.
  if docker compose version >/dev/null 2>&1; then
    compose() { docker compose "$@"; }
    info "compose           $(docker compose version --short 2>/dev/null || echo v2)"
  elif have docker-compose; then
    compose() { docker-compose "$@"; }
    warn "using the standalone docker-compose; the v2 plugin is recommended"
    info "compose           $(docker-compose version --short 2>/dev/null || echo v1)"
  else
    die "Docker Compose is not available." \
      "Install the compose plugin:" \
      "  Debian/Ubuntu sudo apt-get install docker-compose-plugin" \
      "  Fedora/RHEL   sudo dnf install docker-compose-plugin" \
      "  macOS/Windows it ships with Docker Desktop" \
      "Verify with: docker compose version"
  fi

  if ! have curl && ! have wget; then
    die "Neither curl nor wget is installed." \
      "One of them is needed to wait for Platter to come up:" \
      "  sudo apt-get install curl   # or: sudo dnf install curl"
  fi
}

# The port is only a problem if something *else* holds it. On an upgrade Platter holds it
# itself, and failing there would make the second run of an idempotent script an error.
port_held_by_platter() {
  docker ps --filter "name=^${CONTAINER_NAME}\$" --format '{{.Ports}}' 2>/dev/null |
    grep -q ":$1->" 2>/dev/null
}

# Several probes because no single one is everywhere: `ss` is iproute2, `netstat` is
# net-tools (dropped from most minimal images), `lsof` and `fuser` are psmisc-ish, and plenty
# of container hosts carry none of them. The curl fallback needs nothing extra — exit code 7
# is specifically "failed to connect", so anything else means something answered or hung,
# which either way means the port is taken.
port_in_use() {
  if have ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  elif have netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  elif have lsof; then
    lsof -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
  elif have fuser; then
    fuser "$1"/tcp >/dev/null 2>&1
  elif have curl; then
    _rc=0
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1" 2>/dev/null || _rc=$?
    [ "$_rc" -ne 7 ]
  else
    # Nothing to probe with. Do not fail an install over a check that could not be made —
    # `docker compose up` reports the bind conflict clearly enough on its own.
    return 1
  fi
}

check_port() {
  if port_held_by_platter "$PLATTER_PORT"; then
    info "port $PLATTER_PORT        held by this Platter install (upgrade)"
    return 0
  fi
  if port_in_use "$PLATTER_PORT"; then
    die "Port $PLATTER_PORT is already in use by something else." \
      "See what has it:" \
      "  sudo ss -ltnp | grep :$PLATTER_PORT" \
      "Then either stop that, or give Platter a different port:" \
      "  install.sh --port 9000"
  fi
  info "port $PLATTER_PORT        free"
}

check_disk() {
  _avail=$(df -Pk "$1" 2>/dev/null | awk 'NR==2 {print int($4/1024)}' || true)
  case "$_avail" in
  '' | *[!0-9]*)
    warn "could not read free space on $1; skipping the disk check"
    return 0
    ;;
  esac

  if [ "$_avail" -lt "$DISK_REQUIRED_MB" ]; then
    die "Only ${_avail} MB free on $1; Platter's image needs about ${DISK_REQUIRED_MB} MB." \
      "Free some space, or install somewhere with more room:" \
      "  install.sh --dir /path/with/space" \
      "Docker's own cache is often the culprit:" \
      "  docker system df && docker system prune"
  fi

  if [ "$_avail" -lt "$DISK_COMFORTABLE_MB" ]; then
    info "disk              ${_avail} MB free"
    warn "under ${DISK_COMFORTABLE_MB} MB free — enough to install, but game server worlds and backups grow fast"
  else
    info "disk              ${_avail} MB free"
  fi
}

# ---------------------------------------------------------------------------
# Values people get wrong
# ---------------------------------------------------------------------------

# 48 random bytes, base64. The alphabet is A–Z a–z 0–9 + / = with no `$`, which matters:
# Docker Compose interpolates `$` in .env values, and a secret containing one would be
# silently mangled into something shorter.
generate_secret() {
  if have openssl; then
    openssl rand -base64 48 | tr -d '\n'
    return 0
  fi
  if [ -r /dev/urandom ]; then
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | dd bs=1 count=64 2>/dev/null
    return 0
  fi
  return 1
}

# The GID that owns the Docker socket. Platter runs unprivileged inside the container, so it
# needs this group added to reach the daemon. The usual advice is "it's 999" — it is 999 on
# Debian and Ubuntu, 998 on Arch, 0 on some Docker Desktop setups, and whatever the sysadmin
# chose everywhere else, so it is read rather than assumed.
detect_docker_gid() {
  _sock=/var/run/docker.sock
  [ -S "$_sock" ] || return 1
  stat -c '%g' "$_sock" 2>/dev/null && return 0 # GNU coreutils
  stat -f '%g' "$_sock" 2>/dev/null && return 0 # BSD and macOS
  return 1
}

# This host's address on the network, taken from the source address the kernel would put on a
# packet leaving by the default route. `ip route get` is a routing-table lookup — it sends
# nothing and works with no internet connection.
#
# This matters more than it looks. PUBLIC_HOST is the address Platter shows players for every
# game server; left at 127.0.0.1 it shows every one of them an address that only resolves on
# the machine the panel is running on.
detect_lan_ip() {
  if have ip; then
    _ip=$(ip -4 route get 1.1.1.1 2>/dev/null |
      sed -n 's/.*[[:space:]]src[[:space:]]\{1,\}\([0-9.]\{1,\}\).*/\1/p' | head -n 1 || true)
    [ -n "${_ip:-}" ] && {
      printf '%s\n' "$_ip"
      return 0
    }
  fi
  if have route && have ipconfig; then # macOS
    _if=$(route -n get default 2>/dev/null | sed -n 's/.*interface: *//p' | head -n 1 || true)
    if [ -n "${_if:-}" ]; then
      _ip=$(ipconfig getifaddr "$_if" 2>/dev/null || true)
      [ -n "${_ip:-}" ] && {
        printf '%s\n' "$_ip"
        return 0
      }
    fi
  fi
  if have hostname; then
    _ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' |
      grep -v '^127\.' | head -n 1 || true)
    [ -n "${_ip:-}" ] && {
      printf '%s\n' "$_ip"
      return 0
    }
  fi
  return 1
}

# ---------------------------------------------------------------------------
# .env
#
# An existing file is never rewritten. Keys that are missing get appended; keys that are
# present are left exactly as the operator left them. That is what makes a second run an
# upgrade rather than a reset — in particular it keeps JWT_SECRET, and changing that would
# sign every user out.
# ---------------------------------------------------------------------------

env_get() {
  [ -f "$ENV_FILE" ] || return 1
  _v=$(sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1 || true)
  [ -n "${_v:-}" ] || return 1
  printf '%s\n' "$_v"
}

env_has() { [ -f "$ENV_FILE" ] && grep -q "^$1=" "$ENV_FILE" 2>/dev/null; }

env_append() {
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  info "added $1 to .env"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

say ''
say "  ${B}Platter${R} — self-hosted game server control panel"
say ''

preflight

# Resolve the target path without creating it. Every check below has to be able to fail
# without leaving a half-made install directory behind on a machine that refused the install.
if [ -d "$PLATTER_DIR" ]; then
  DIR=$(cd "$PLATTER_DIR" && pwd)
else
  case "$PLATTER_DIR" in
  /*) DIR=$PLATTER_DIR ;;
  *) DIR="$(pwd)/${PLATTER_DIR#./}" ;;
  esac
fi
ENV_FILE="$DIR/.env"
COMPOSE_FILE="$DIR/docker-compose.yml"

UPGRADE=no
[ -f "$ENV_FILE" ] && UPGRADE=yes

# On an upgrade the file on disk is the authority, so reconcile against it *here* — before the
# port is checked and before the banner is printed. Doing it later meant probing whichever port
# the flags asked for rather than the one Platter is actually on (a free-port check against the
# wrong number), and printing a banner promising settings the install then declined to apply.
if [ "$UPGRADE" = yes ]; then
  _file_port=$(env_get PLATTER_PORT || true)
  if [ -n "${_file_port:-}" ] && [ "$_file_port" != "$PLATTER_PORT" ]; then
    warn ".env says PLATTER_PORT=$_file_port; keeping it rather than switching to $PLATTER_PORT"
    warn "edit $ENV_FILE if you meant to change it"
    PLATTER_PORT=$_file_port
  fi
  _file_image=$(env_get PLATTER_IMAGE || true)
  [ -n "${_file_image:-}" ] && PLATTER_IMAGE=$_file_image
  _file_bind=$(env_get PLATTER_BIND || true)
  [ -n "${_file_bind:-}" ] && PLATTER_BIND=$_file_bind
fi

check_port

# df needs a path that exists, so walk up to the closest ancestor that does. That is the
# filesystem the new directory will land on anyway.
_probe=$DIR
while [ ! -d "$_probe" ]; do
  _parent=$(dirname "$_probe")
  [ "$_parent" = "$_probe" ] && break
  _probe=$_parent
done
check_disk "$_probe"

say ''
if [ "$UPGRADE" = yes ]; then
  step "Upgrading the install in $DIR"
  note "Found an existing .env. It will be read, not rewritten — your secret,"
  note "settings and data volume are kept exactly as they are."
else
  step "Installing into $DIR"
  note "Two files will be written here: .env and docker-compose.yml."
  note "Nothing outside this directory is touched, and no packages are installed."
fi
say ''
info "image             $PLATTER_IMAGE"
if [ "$PLATTER_BIND" = 0.0.0.0 ]; then
  info "published on      every interface on this host (0.0.0.0)"
else
  info "published on      $PLATTER_BIND only"
fi
info "web interface     http://localhost:$PLATTER_PORT"
info "data             one Docker volume, platter-data"
say ''
note "Platter manages game servers as sibling containers, so the compose file mounts"
note "/var/run/docker.sock. Anything that can write to that socket is equivalent to"
note "root on this host. That is the trade every Docker control panel makes."
say ''

if ! confirm "Continue?"; then
  say 'Nothing was written.'
  exit 0
fi
say ''

# Everything above could still bail without touching the disk. This is the first write.
mkdir -p "$DIR" 2>/dev/null ||
  die "Cannot create $DIR." \
    "Check the parent directory exists and that you may write to it, or pick another:" \
    "  install.sh --dir \$HOME/platter"

# --- .env -------------------------------------------------------------------

step "Configuration"

if [ "$UPGRADE" = no ]; then
  SECRET=$(generate_secret) ||
    die "Could not generate a signing secret: no openssl and no readable /dev/urandom." \
      "Install openssl and run this again:" \
      "  sudo apt-get install openssl   # or: sudo dnf install openssl"
  [ -n "$SECRET" ] ||
    die "Generated an empty signing secret." "Please open an issue — this should not happen."

  DOCKER_GID=$(detect_docker_gid || true)
  if [ -n "${DOCKER_GID:-}" ]; then
    info "docker socket GID $DOCKER_GID (read from /var/run/docker.sock)"
  else
    DOCKER_GID=999
    warn "could not read the Docker socket's group; falling back to $DOCKER_GID"
    warn "if Platter cannot reach the daemon, set DOCKER_GID in $ENV_FILE to the output of:"
    warn "  stat -c '%g' /var/run/docker.sock"
  fi

  if [ -n "$PLATTER_PUBLIC_HOST" ]; then
    PUBLIC_HOST=$PLATTER_PUBLIC_HOST
    info "public host       $PUBLIC_HOST (given)"
  else
    PUBLIC_HOST=$(detect_lan_ip || true)
    if [ -n "${PUBLIC_HOST:-}" ]; then
      info "public host       $PUBLIC_HOST (this host's address on its default route)"
      PUBLIC_HOST=$(ask "  Address players will use to reach your game servers" "$PUBLIC_HOST")
    else
      PUBLIC_HOST=127.0.0.1
      warn "could not work out this host's network address; using $PUBLIC_HOST"
      warn "game servers will show an address only this machine can reach until you set"
      warn "PUBLIC_HOST in $ENV_FILE to your LAN address or public DNS name"
    fi
  fi

  umask 077
  cat >"$ENV_FILE.tmp" <<EOF
# Platter configuration. Written by install.sh on $(date -u '+%Y-%m-%d %H:%M:%S UTC').
#
# Edit anything here, then: docker compose up -d
# The full annotated set is at https://github.com/thekozugroup/Platter/blob/main/.env.example

# Signs access and refresh tokens. Changing it signs everybody out, which is exactly what
# you want if it ever leaks. Keep it out of version control.
JWT_SECRET=$SECRET

# The container image. Pin a version here to stop 'docker compose pull' moving you.
PLATTER_IMAGE=$PLATTER_IMAGE

# Which interface the web interface is published on. 0.0.0.0 is every interface. On a host
# with a public address, set this to a private or VPN address unless you intend Platter to be
# reachable from the internet — first-run setup is unauthenticated, so a fresh instance is
# claimed by whoever opens it first.
PLATTER_BIND=$PLATTER_BIND

# The port Platter's web interface listens on.
PLATTER_PORT=$PLATTER_PORT

# The address players use to reach your game servers. Platter shows this for every server,
# so a wrong value here shows everyone an address that does not work.
PUBLIC_HOST=$PUBLIC_HOST

# Host ports Platter may allocate to game servers. Forward these on your router if you want
# people outside your network to connect. One server usually takes two or three.
PORT_RANGE_START=25000
PORT_RANGE_END=25999

# GID of the group owning /var/run/docker.sock. Platter runs unprivileged and needs it to
# reach the daemon. Re-read it with: stat -c '%g' /var/run/docker.sock
DOCKER_GID=$DOCKER_GID

# Optional. Without a key the AI features are hidden rather than broken; everything else
# works. https://console.anthropic.com
ANTHROPIC_API_KEY=
AI_MODEL=claude-opus-5

# Off by default: on a self-hosted panel, open registration means anyone who finds the URL
# can make an account. Invite people from the admin area instead. The first account is
# created regardless of this setting, and always owns the installation.
REGISTRATION_ENABLED=false

LOG_LEVEL=info
EOF
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  umask 022
  info "wrote $ENV_FILE"
  note "It holds your signing secret. Mode 600, and it should stay out of git."
else
  # Upgrade. Fill gaps only; never overwrite.
  if ! env_has JWT_SECRET || [ -z "$(env_get JWT_SECRET || true)" ]; then
    SECRET=$(generate_secret) || die "Could not generate a signing secret." "Install openssl and retry."
    env_append JWT_SECRET "$SECRET"
    warn "the existing .env had no JWT_SECRET; a new one was appended and everyone will be signed out"
  fi
  # Missing keys are appended; present ones are never touched. The port and image were already
  # reconciled against this file before the banner.
  env_has PLATTER_IMAGE || env_append PLATTER_IMAGE "$PLATTER_IMAGE"
  env_has PLATTER_PORT || env_append PLATTER_PORT "$PLATTER_PORT"
  env_has PLATTER_BIND || env_append PLATTER_BIND "$PLATTER_BIND"
  env_has PUBLIC_HOST || env_append PUBLIC_HOST "$(detect_lan_ip || echo 127.0.0.1)"
  env_has DOCKER_GID || env_append DOCKER_GID "$(detect_docker_gid || echo 999)"

  info "kept the existing .env unchanged"
fi

# --- docker-compose.yml -----------------------------------------------------
#
# Fully static: every value it needs comes from .env, so this file is byte-identical on every
# run and an upgrade has nothing to diff. Quoted heredoc, so `${…}` reaches Compose intact.

cat >"$COMPOSE_FILE.tmp" <<'COMPOSE'
# Platter. Managed by install.sh — edit .env for configuration, not this file.
#
# One container, one volume. Everything it reads comes from .env beside it.

services:
  platter:
    image: ${PLATTER_IMAGE:-ghcr.io/thekozugroup/platter:latest}
    container_name: platter
    restart: unless-stopped
    ports:
      - '${PLATTER_BIND:-0.0.0.0}:${PLATTER_PORT:-8080}:8080'
    environment:
      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in .env}
      PUBLIC_HOST: ${PUBLIC_HOST:-127.0.0.1}
      PORT_RANGE_START: ${PORT_RANGE_START:-25000}
      PORT_RANGE_END: ${PORT_RANGE_END:-25999}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      AI_MODEL: ${AI_MODEL:-claude-opus-5}
      REGISTRATION_ENABLED: ${REGISTRATION_ENABLED:-false}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    volumes:
      - platter-data:/data
      # Platter manages game servers as sibling containers on this host's daemon. Anything
      # that can write to this socket can start a container that mounts the host filesystem,
      # so this is equivalent to root here. Prefer a rootless daemon or a socket proxy for
      # anything multi-tenant, and read docs/DEPLOYMENT.md before exposing this instance.
      - /var/run/docker.sock:/var/run/docker.sock
    # The container runs unprivileged, so it needs the host group that owns the socket.
    group_add:
      - ${DOCKER_GID:-999}
    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:8080/api/v1/system/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'

volumes:
  platter-data:
COMPOSE
mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
info "wrote $COMPOSE_FILE"

# --- up ---------------------------------------------------------------------

say ''
step "Starting Platter"

cd "$DIR"

# Deliberately not piped through `sed` for indentation. Without `pipefail` — which is not in
# POSIX sh — the exit status of `cmd | sed` is sed's, so a failed pull would report success and
# the script would sail past it. Live progress on a 900 MB download is worth more than a
# four-space indent, and an honest exit status is worth more than both.
#
# A pull failure is only fatal when there is no image to fall back on. That covers three real
# cases: an upgrade on a host that has briefly lost the network, an operator running an image
# they built themselves, and a pinned tag already on disk.
if ! compose pull; then
  if docker image inspect "$PLATTER_IMAGE" >/dev/null 2>&1; then
    warn "could not pull $PLATTER_IMAGE; using the copy already on this host"
  else
    die "Could not pull $PLATTER_IMAGE, and it is not already on this host." \
      "Check this host can reach the registry:" \
      "  docker pull $PLATTER_IMAGE" \
      "If you are behind a proxy, Docker needs it set for the daemon, not just your shell:" \
      "  https://docs.docker.com/engine/daemon/proxy/"
  fi
fi

if ! compose up -d; then
  die "docker compose up failed." \
    "The output above says why. The usual causes are a port conflict and a bad .env value." \
    "Look at the full log with:" \
    "  cd $DIR && docker compose logs"
fi

# --- wait -------------------------------------------------------------------

say ''
step "Waiting for Platter to answer"

READY_URL="http://127.0.0.1:$PLATTER_PORT$READY_PATH"
elapsed=0
ready=no
while [ "$elapsed" -lt "$READY_TIMEOUT" ]; do
  if http_ok "$READY_URL"; then
    ready=yes
    break
  fi
  # A container that has already exited is never going to answer; fail now rather than in
  # three minutes' time.
  if [ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo missing)" = exited ]; then
    say ''
    compose logs --tail 40 2>&1 | sed 's/^/    /' || true
    die "The Platter container started and then exited." \
      "The last of its log is above. Full output:" \
      "  cd $DIR && docker compose logs"
  fi
  elapsed=$((elapsed + 2))
  sleep 2
  printf '.'
done
printf '\n'

if [ "$ready" != yes ]; then
  say ''
  compose logs --tail 40 2>&1 | sed 's/^/    /' || true
  die "Platter did not become ready within ${READY_TIMEOUT}s." \
    "The last of its log is above. It may just be slow on first boot — check with:" \
    "  cd $DIR && docker compose logs -f" \
    "  curl $READY_URL"
fi

# --- done -------------------------------------------------------------------

PUBLIC_HOST=$(env_get PUBLIC_HOST || echo 127.0.0.1)

say ''
printf '%s  Platter is running.%s\n' "$GRN$B" "$R"
say ''
say "  ${B}http://localhost:$PLATTER_PORT${R}"
if [ "$PUBLIC_HOST" != 127.0.0.1 ] && [ "$PUBLIC_HOST" != localhost ]; then
  say "  ${D}http://$PUBLIC_HOST:$PLATTER_PORT${R}  ${D}— from another machine on your network${R}"
fi
say ''
say "  ${B}Next:${R} open that address and create the first account."
say '        No account exists yet and there is no default password. The first'
say '        one you create owns the installation — it can add servers, nodes'
say '        and everyone else.'
say ''
note "Installed in $DIR"
note "  docker compose logs -f     follow the log"
note "  docker compose restart     restart"
note "  docker compose pull && docker compose up -d    upgrade"
note "  docker compose down        stop (the data volume is kept)"
say ''
note "Players will be given $PUBLIC_HOST to connect to — change PUBLIC_HOST in"
note "$ENV_FILE if that is not the address your players use."
say ''
