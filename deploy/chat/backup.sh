#!/usr/bin/env bash
set -euo pipefail

backup_root="/var/backups/mimir-chat"
retention_days="${MIMIR_CHAT_BACKUP_RETENTION_DAYS:-14}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${backup_root}/mimir-chat-${stamp}.tar.zst"
partial="${archive}.partial"
lock="/run/mimir-chat-backup.lock"
chat_was_active=0
files_were_active=0
admin_was_active=0
services_stopped=0

if [[ "$(id -u)" -ne 0 ]]; then
	echo "mimir-chat-backup must run as root" >&2
	exit 1
fi
if ! [[ "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 1 )); then
	echo "MIMIR_CHAT_BACKUP_RETENTION_DAYS must be a positive integer" >&2
	exit 1
fi

install -d -m 0700 "$backup_root"
exec 9>"$lock"
flock -n 9 || {
	echo "another Mimir Chat backup is already running" >&2
	exit 1
}

restore_services() {
	local status=$?
	if (( services_stopped )); then
		if (( chat_was_active )); then
			systemctl start mimir-chat.service || status=1
		fi
		if (( files_were_active )); then
			systemctl start mimir-chat-files.service || status=1
		fi
		if (( admin_was_active )); then
			systemctl start mimir-chat-admin.service || status=1
		fi
	fi
	rm -f -- "$partial"
	exit "$status"
}
trap restore_services EXIT INT TERM

systemctl is-active --quiet mimir-chat.service && chat_was_active=1
systemctl is-active --quiet mimir-chat-files.service && files_were_active=1
systemctl is-active --quiet mimir-chat-admin.service && admin_was_active=1
if (( admin_was_active )); then
	systemctl stop mimir-chat-admin.service
fi
if (( files_were_active )); then
	systemctl stop mimir-chat-files.service
fi
if (( chat_was_active )); then
	systemctl stop mimir-chat.service
fi
services_stopped=1

tar \
	--create \
	--zstd \
	--file "$partial" \
	--numeric-owner \
	--acls \
	--xattrs \
	--directory / \
	etc/mimir-chat \
	var/lib/mimir-chat \
	opt/mimir-chat/current
chmod 0600 "$partial"
mv -- "$partial" "$archive"
sha256sum "$archive" > "${archive}.sha256"
chmod 0600 "${archive}.sha256"

if (( chat_was_active )); then
	systemctl start mimir-chat.service
fi
if (( files_were_active )); then
	systemctl start mimir-chat-files.service
fi
if (( admin_was_active )); then
	systemctl start mimir-chat-admin.service
fi
services_stopped=0

find "$backup_root" -maxdepth 1 -type f \
	-name 'mimir-chat-*.tar.zst' -mtime "+${retention_days}" -delete
find "$backup_root" -maxdepth 1 -type f \
	-name 'mimir-chat-*.tar.zst.sha256' -mtime "+${retention_days}" -delete

trap - EXIT INT TERM
printf '%s\n' "$archive"
