#!/usr/bin/env bash
set -euo pipefail

version="2.19.0"
archive="ergo-${version}-linux-arm64.tar.gz"
release_url="https://github.com/ergochat/ergo/releases/download/v${version}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
release_dir="/opt/mimir-chat/releases/${version}"
config_dir="/etc/mimir-chat"
data_dir="/var/lib/mimir-chat"
password_file="${config_dir}/waqr.pass"
admin_password_file="${config_dir}/admin-irc.pass"
admin_token_hash_file="${config_dir}/admin.token.sha256"
admin_token_source=""
secure_config=""
bootstrap_mode=false

usage() {
	echo "usage: install.sh [--admin-token-file PATH]" >&2
	exit 2
}

while [[ "$#" -gt 0 ]]; do
	case "$1" in
		--admin-token-file)
			[[ "$#" -ge 2 ]] || usage
			admin_token_source="$2"
			shift 2
			;;
		*)
			usage
			;;
	esac
done

if [[ "$(id -u)" -ne 0 ]]; then
	echo "install.sh must run as root" >&2
	exit 1
fi
if [[ "$(uname -m)" != "aarch64" ]]; then
	echo "this pinned deployment expects aarch64" >&2
	exit 1
fi
if [[ ! -x /usr/bin/node ]]; then
	echo "Mimir Chat administration requires Node.js 22 at /usr/bin/node" >&2
	exit 1
fi
node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
if ! [[ "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
	echo "Mimir Chat administration requires Node.js 22 or newer" >&2
	exit 1
fi

if ! id mimir-chat >/dev/null 2>&1; then
	useradd --system --home-dir "$data_dir" --shell /usr/sbin/nologin mimir-chat
fi

install -d -m 0755 /opt/mimir-chat/releases
install -d -m 0750 -o root -g mimir-chat "$config_dir"
install -d -m 0750 -o mimir-chat -g mimir-chat "$data_dir"

temporary_dir="$(mktemp -d /tmp/mimir-chat-install.XXXXXX)"
secure_config="${temporary_dir}/ircd.secure.yaml"
cleanup() {
	if [[ "$bootstrap_mode" == true && -f "$secure_config" ]]; then
		# Never leave the localhost SASL exemption behind if first-account
		# provisioning fails. The secure configuration fails closed.
		install -m 0640 -o root -g mimir-chat "$secure_config" "${config_dir}/ircd.yaml"
		systemctl reload mimir-chat.service >/dev/null 2>&1 \
			|| systemctl restart mimir-chat.service >/dev/null 2>&1 \
			|| true
	fi
	rm -rf "$temporary_dir"
}
trap cleanup EXIT

curl -fsSLo "${temporary_dir}/${archive}" "${release_url}/${archive}"
curl -fsSLo "${temporary_dir}/checksums.txt" "${release_url}/ergo-${version}-checksums.txt"
expected="$(awk -v name="$archive" '$2 == name { print $1 }' "${temporary_dir}/checksums.txt")"
actual="$(sha256sum "${temporary_dir}/${archive}" | awk '{ print $1 }')"
if [[ -z "$expected" || "$expected" != "$actual" ]]; then
	echo "Ergo release checksum verification failed" >&2
	exit 1
fi

tar -xzf "${temporary_dir}/${archive}" -C "$temporary_dir"
source_dir="${temporary_dir}/ergo-${version}-linux-arm64"
install -d -m 0755 "$release_dir"
install -m 0755 "${source_dir}/ergo" "${release_dir}/ergo"
install -m 0644 "${source_dir}/default.yaml" "${release_dir}/default.yaml"
install -m 0644 "${source_dir}/ergo.motd" "${release_dir}/ergo.motd"
install -m 0755 "${script_dir}/file_service.py" "${release_dir}/file_service.py"
install -m 0755 "${script_dir}/admin_service.mjs" "${release_dir}/admin_service.mjs"
install -m 0644 "${script_dir}/admin.html" "${release_dir}/admin.html"
rm -rf "${release_dir}/languages"
cp -R "${source_dir}/languages" "${release_dir}/languages"
find "${release_dir}/languages" -type d -exec chmod 0755 {} +
find "${release_dir}/languages" -type f -exec chmod 0644 {} +
ln -sfn "$release_dir" /opt/mimir-chat/current

if [[ ! -f "$password_file" ]]; then
	umask 077
	openssl rand -hex 24 > "$password_file"
fi
chmod 0600 "$password_file"
if [[ ! -f "$admin_password_file" ]]; then
	umask 077
	openssl rand -hex 24 > "$admin_password_file"
fi
chown root:mimir-chat "$admin_password_file"
chmod 0640 "$admin_password_file"

if [[ -n "$admin_token_source" ]]; then
	[[ -f "$admin_token_source" ]] || {
		echo "administration token file does not exist: $admin_token_source" >&2
		exit 1
	}
	admin_token="$(<"$admin_token_source")"
	[[ "${#admin_token}" -ge 32 && "$admin_token" != *[[:space:]]* ]] || {
		echo "administration token must be at least 32 characters without whitespace" >&2
		exit 1
	}
	printf '%s' "$admin_token" | sha256sum | awk '{ print $1 }' > "$admin_token_hash_file"
	unset admin_token
elif [[ ! -f "$admin_token_hash_file" ]]; then
	echo "first installation requires --admin-token-file PATH" >&2
	exit 1
fi
chown root:mimir-chat "$admin_token_hash_file"
chmod 0640 "$admin_token_hash_file"

password="$(tr -d '\r\n' < "$password_file")"
admin_password="$(tr -d '\r\n' < "$admin_password_file")"
oper_hash="$(printf '%s\n' "$password" | "${release_dir}/ergo" genpasswd)"
admin_oper_hash="$(printf '%s\n' "$admin_password" | "${release_dir}/ergo" genpasswd)"
MIMIR_CHAT_OPER_HASH="$oper_hash" MIMIR_CHAT_ADMIN_OPER_HASH="$admin_oper_hash" \
	python3 "${script_dir}/configure.py" \
		--source "${release_dir}/default.yaml" \
		--output "$secure_config"
if systemctl is-active --quiet mimir-chat.service; then
	chat_was_active=true
	install -m 0640 -o root -g mimir-chat "$secure_config" "${config_dir}/ircd.yaml"
else
	chat_was_active=false
	MIMIR_CHAT_OPER_HASH="$oper_hash" MIMIR_CHAT_ADMIN_OPER_HASH="$admin_oper_hash" \
		python3 "${script_dir}/configure.py" \
			--source "${release_dir}/default.yaml" \
			--output "${config_dir}/ircd.yaml" \
			--bootstrap-local-only
	bootstrap_mode=true
fi
chown root:mimir-chat "${config_dir}/ircd.yaml"
chmod 0640 "${config_dir}/ircd.yaml"

install -m 0644 "${script_dir}/mimir-chat.service" /etc/systemd/system/mimir-chat.service
install -m 0644 "${script_dir}/mimir-chat-files.service" /etc/systemd/system/mimir-chat-files.service
install -m 0644 "${script_dir}/mimir-chat-admin.service" /etc/systemd/system/mimir-chat-admin.service
install -m 0644 "${script_dir}/mimir-chat-backup.service" /etc/systemd/system/mimir-chat-backup.service
install -m 0644 "${script_dir}/mimir-chat-backup.timer" /etc/systemd/system/mimir-chat-backup.timer
install -m 0644 "${script_dir}/mimir-chat-health.service" /etc/systemd/system/mimir-chat-health.service
install -m 0644 "${script_dir}/mimir-chat-health.timer" /etc/systemd/system/mimir-chat-health.timer
install -m 0750 "${script_dir}/manage_user.py" /usr/local/sbin/mimir-chat-user
install -m 0750 "${script_dir}/backup.sh" /usr/local/sbin/mimir-chat-backup
install -m 0750 "${script_dir}/restore.sh" /usr/local/sbin/mimir-chat-restore
install -m 0755 "${script_dir}/health.sh" /usr/local/sbin/mimir-chat-health
systemctl daemon-reload
systemctl enable --now mimir-chat.service
if [[ "$chat_was_active" == true ]]; then
	systemctl reload mimir-chat.service
fi

for _ in $(seq 1 20); do
	if bash -c "</dev/tcp/127.0.0.1/16667" 2>/dev/null; then
		break
	fi
	sleep 0.25
done
systemctl is-active --quiet mimir-chat.service
python3 "${script_dir}/bootstrap.py" \
	--password-file "$password_file" \
	--admin-password-file "$admin_password_file"
if [[ "$chat_was_active" == false ]]; then
	install -m 0640 -o root -g mimir-chat "$secure_config" "${config_dir}/ircd.yaml"
	systemctl reload mimir-chat.service
	bootstrap_mode=false
fi

for _ in $(seq 1 20); do
	if bash -c "</dev/tcp/127.0.0.1/8067" 2>/dev/null; then
		break
	fi
	sleep 0.25
done
systemctl enable --now mimir-chat-files.service
systemctl enable --now mimir-chat-admin.service
systemctl enable --now mimir-chat-backup.timer
systemctl enable --now mimir-chat-health.timer
systemctl is-active --quiet mimir-chat-files.service
systemctl is-active --quiet mimir-chat-admin.service

echo "Mimir Chat service installed and bootstrapped"
