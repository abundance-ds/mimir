#!/usr/bin/env bash
set -euo pipefail

for unit in mimir-chat.service mimir-chat-files.service mimir-chat-admin.service caddy.service; do
	systemctl is-active --quiet "$unit" || {
		echo "$unit is not active" >&2
		exit 1
	}
done
for port in 16667 8067 8069 8070; do
	timeout 2 bash -c "</dev/tcp/127.0.0.1/${port}" 2>/dev/null || {
		echo "Mimir Chat loopback port $port is unavailable" >&2
		exit 1
	}
done

auth_response="$(
	timeout 3 bash -c '
		exec 3<>/dev/tcp/127.0.0.1/16667
		printf "NICK mimir-health-unauthenticated\r\nUSER mimir-health-unauthenticated 0 * :Mimir auth boundary\r\nJOIN #general\r\n" >&3
		cat <&3
	' 2>/dev/null || true
)"
[[ "$auth_response" == *"ACCOUNT_REQUIRED"* && "$auth_response" != *" JOIN #general"* ]] || {
	echo "chat authentication boundary did not reject an anonymous session" >&2
	exit 1
}

[[ "$(curl -fsS --max-time 5 https://chat.abundanceds.com/healthz)" == "ok" ]] || {
	echo "public chat health endpoint failed" >&2
	exit 1
}
file_health="$(curl -fsS --max-time 5 http://127.0.0.1:8069/healthz)"
[[ "$file_health" == *'"ok":true'* ]] || {
	echo "attachment service health endpoint failed" >&2
	exit 1
}
admin_health="$(curl -fsS --max-time 5 http://127.0.0.1:8070/healthz)"
[[ "$admin_health" == *'"ok":true'* ]] || {
	echo "administration service health endpoint failed" >&2
	exit 1
}
status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
	https://chat.abundanceds.com/files/health-auth-boundary)"
[[ "$status" == "401" ]] || {
	echo "attachment authentication boundary returned HTTP $status, expected 401" >&2
	exit 1
}
admin_page="$(curl -fsS --max-time 5 https://chat.abundanceds.com/admin/)"
[[ "$admin_page" == *"Mimir Chat administration"* ]] || {
	echo "public administration page failed" >&2
	exit 1
}
admin_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
	https://chat.abundanceds.com/admin/api/state)"
[[ "$admin_status" == "401" ]] || {
	echo "administration authentication boundary returned HTTP $admin_status, expected 401" >&2
	exit 1
}

available_kib="$(df --output=avail /var/lib/mimir-chat | tail -n 1)"
if (( available_kib < 1048576 )); then
	echo "less than 1 GiB remains on the chat data filesystem" >&2
	exit 1
fi

echo "Mimir Chat healthy"
