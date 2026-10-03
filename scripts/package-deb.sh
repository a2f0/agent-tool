#!/bin/sh
set -eu
umask 022
if [ "$#" -ne 2 ]; then
  echo "Usage: scripts/package-deb.sh <linux-binary> <amd64|arm64>" >&2
  exit 1
fi
case "$2" in amd64|arm64) ;; *) echo "Unsupported Debian architecture" >&2; exit 1 ;; esac
binary=$(realpath "$1")
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(bun -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$project/package.json")
stage=$(mktemp -d)
chmod 755 "$stage"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/DEBIAN" "$stage/usr/bin" "$project/dist"
install -m 755 "$binary" "$stage/usr/bin/agent-tool"
cat > "$stage/DEBIAN/control" <<EOF
Package: agent-tool
Version: $version
Section: devel
Priority: optional
Architecture: $2
Maintainer: Agent Tool maintainers
Depends: git, libc6 (>= 2.31)
Recommends: gh
Description: Portable cross-agent reviews, PR workflows, and shared skills
 Includes a standalone executable with embedded skill instructions.
 Reviewer CLIs and their authentication are configured separately.
EOF
dpkg-deb --root-owner-group --build "$stage" "$project/dist/agent-tool_${version}_$2.deb"
