#!/usr/bin/env bash
set -euo pipefail

backup_root="/var/backups/mimir-chat"
confirm=0

usage() {
	echo "usage: mimir-chat-restore [--confirm] /var/backups/mimir-chat/mimir-chat-*.tar.zst" >&2
	exit 2
}

if [[ "$(id -u)" -ne 0 ]]; then
	echo "mimir-chat-restore must run as root" >&2
	exit 1
fi
if [[ "${1:-}" == "--confirm" ]]; then
	confirm=1
	shift
fi
[[ "$#" -eq 1 ]] || usage
archive="$(readlink -f -- "$1")"
[[ -f "$archive" ]] || {
	echo "backup archive does not exist: $archive" >&2
	exit 1
}
[[ -f "${archive}.sha256" ]] || {
	echo "backup checksum is missing: ${archive}.sha256" >&2
	exit 1
}
(cd "$(dirname "$archive")" && sha256sum --check "$(basename "${archive}.sha256")")

entries="$(tar --list --file "$archive")"
while IFS= read -r entry; do
	case "$entry" in
		etc/mimir-chat|etc/mimir-chat/*|var/lib/mimir-chat|var/lib/mimir-chat/*|opt/mimir-chat/current) ;;
		*)
			echo "backup contains an unexpected path: $entry" >&2
			exit 1
			;;
	esac
	if [[ "$entry" == /* || "$entry" == *"/../"* || "$entry" == "../"* ]]; then
		echo "backup contains an unsafe path: $entry" >&2
		exit 1
	fi
done <<< "$entries"

staging="$(mktemp -d /tmp/mimir-chat-restore.XXXXXX)"
cleanup() {
	rm -rf -- "$staging"
}
trap cleanup EXIT
tar --extract --file "$archive" --directory "$staging" --numeric-owner --acls --xattrs
[[ -d "$staging/etc/mimir-chat" && -d "$staging/var/lib/mimir-chat" ]] || {
	echo "backup is missing required chat directories" >&2
	exit 1
}
current_target="$(readlink "$staging/opt/mimir-chat/current")"
[[ "$current_target" == /opt/mimir-chat/releases/* && -x "$current_target/ergo" ]] || {
	echo "the backed-up Ergo release is not installed: $current_target" >&2
	exit 1
}
for database in ergo_history.db files.sqlite3; do
	if [[ -f "$staging/var/lib/mimir-chat/$database" ]]; then
		result="$(sqlite3 "$staging/var/lib/mimir-chat/$database" 'PRAGMA integrity_check;')"
		[[ "$result" == "ok" ]] || {
			echo "$database failed SQLite integrity_check: $result" >&2
			exit 1
		}
	fi
done

if (( ! confirm )); then
	echo "backup verified; no production state changed"
	exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous="${backup_root}/prerestore-${stamp}"
failed="${backup_root}/failed-restore-${stamp}"
install -d -m 0700 "$previous/etc" "$previous/var" "$previous/opt/mimir-chat"

systemctl stop mimir-chat-admin.service mimir-chat-files.service mimir-chat.service
mv /etc/mimir-chat "$previous/etc/"
mv /var/lib/mimir-chat "$previous/var/lib-mimir-chat"
mv /opt/mimir-chat/current "$previous/opt/mimir-chat/"
mv "$staging/etc/mimir-chat" /etc/
mv "$staging/var/lib/mimir-chat" /var/lib/
mv "$staging/opt/mimir-chat/current" /opt/mimir-chat/

rollback() {
	local status=$?
	trap - ERR
	systemctl stop mimir-chat-admin.service mimir-chat-files.service mimir-chat.service || true
	install -d -m 0700 "$failed/etc" "$failed/var" "$failed/opt/mimir-chat"
	mv /etc/mimir-chat "$failed/etc/" || true
	mv /var/lib/mimir-chat "$failed/var/lib-mimir-chat" || true
	mv /opt/mimir-chat/current "$failed/opt/mimir-chat/" || true
	mv "$previous/etc/mimir-chat" /etc/
	mv "$previous/var/lib-mimir-chat" /var/lib/mimir-chat
	mv "$previous/opt/mimir-chat/current" /opt/mimir-chat/
	systemctl start mimir-chat.service mimir-chat-files.service mimir-chat-admin.service
	echo "restore failed; prior state was restored from $previous" >&2
	exit "$status"
}
trap rollback ERR

systemctl start mimir-chat.service mimir-chat-files.service mimir-chat-admin.service
/usr/local/sbin/mimir-chat-health
trap - ERR
echo "restore complete; previous state retained at $previous"
