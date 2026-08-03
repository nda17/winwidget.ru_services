#!/usr/bin/env bash

set -Eeuo pipefail

readonly FRONTEND_ATTESTATION_MAX_FILE_SIZE='16384'
readonly FRONTEND_ATTESTATION_PROJECT='winwidget'
readonly FRONTEND_ATTESTATION_SERVICE='client'

frontend_attestation_stat_mode() {
	stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

frontend_attestation_stat_owner() {
	stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

frontend_attestation_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

frontend_attestation_require_safe_file() {
	local path="$1" label="$2" size
	[[ "$path" == /* && -f "$path" && ! -L "$path" &&
		"$(frontend_attestation_stat_owner "$path")" == '0:0' &&
		"$(frontend_attestation_stat_mode "$path")" == '600' ]] || {
		echo "$label must be an absolute root-owned mode-600 regular file." >&2
		return 1
	}
	size="$(wc -c <"$path" | tr -d '[:space:]')" || return 1
	[[ "$size" =~ ^[0-9]+$ && "$size" -ge 32 &&
		"$size" -le "$FRONTEND_ATTESTATION_MAX_FILE_SIZE" ]] || {
		echo "$label has an unsafe size." >&2
		return 1
	}
}

frontend_attestation_require_safe_directory() {
	local path="$1" mode
	[[ "$path" == /* && -d "$path" && ! -L "$path" &&
		"$(frontend_attestation_stat_owner "$path")" == '0:0' ]] || {
		echo 'Frontend attestation output directory must be absolute, root-owned and not a symlink.' >&2
		return 1
	}
	mode="$(frontend_attestation_stat_mode "$path")" || return 1
	[[ "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 0022)) -eq 0 ]] || {
		echo 'Frontend attestation output directory must not be writable by group or others.' >&2
		return 1
	}
}

frontend_attestation_scan_image_contract() {
	local image_id="$1"
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		--entrypoint node "$image_id" -e '
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const root = "/app/.next";
if (!existsSync(root)) process.exit(1);
const forbidden = [
  "/statistics/dashboard",
  "/statistics/overview",
  "/statistics/registrations-by-month",
];
const required = [
  "/admin/reporting",
  "/admin/reporting/daily-summary/settings",
];
const found = new Set();
const visit = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && /\.(?:js|json|html)$/.test(entry.name)) {
      const text = readFileSync(path, "utf8");
      if (forbidden.some(token => text.includes(token)) ||
          /(?:=|:)"\/statistics"/.test(text)) process.exit(1);
      for (const token of required) if (text.includes(token)) found.add(token);
    }
  }
};
visit(root);
if (required.some(token => !found.has(token))) process.exit(1);
' >/dev/null
}

frontend_attestation_asset_path() {
	local image_id="$1" html_file="$2"
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-v "$html_file:/frontend.html:ro" \
		--entrypoint node "$image_id" -e '
const { readFileSync } = require("node:fs");
const html = readFileSync("/frontend.html", "utf8");
const matches = [...html.matchAll(/["'\''`](\/_next\/static\/[A-Za-z0-9._/-]+)["'\''`]/g)]
  .map(match => match[1]);
const path = matches.find(value =>
  !value.split("/").includes("..") && /\.(?:js|css)$/.test(value));
if (!path) process.exit(1);
process.stdout.write(path);
'
}

frontend_attestation_generate() (
	set -Eeuo pipefail
	[[ "$(id -u)" == '0' ]] || {
		echo 'Frontend runtime attestation must run as root on the frontend VPS.' >&2
		return 1
	}
	local backend_revision="${REPORTING_BACKEND_REVISION:-}"
	local frontend_revision="${REPORTING_FRONTEND_REVISION:-}"
	local switch_generation="${REPORTING_SWITCH_GENERATION:-}"
	local challenge="${REPORTING_FRONTEND_RUNTIME_CHALLENGE:-}"
	local origin="${REPORTING_FRONTEND_ORIGIN:-}"
	local output_root="${REPORTING_FRONTEND_ATTESTATION_ROOT:-/opt/winwidget/deploy/frontend}"
	local private_key="${REPORTING_FRONTEND_ATTESTATION_PRIVATE_KEY:-$output_root/reporting-frontend-runtime-attestation-v1.private.pem}"
	local public_key="${REPORTING_FRONTEND_ATTESTATION_PUBLIC_KEY:-$output_root/reporting-frontend-runtime-attestation-v1.public.pem}"
	local attestation="${REPORTING_FRONTEND_ATTESTATION_FILE:-$output_root/reporting-frontend-runtime-attestation-v1.json}"
	local signature="${REPORTING_FRONTEND_ATTESTATION_SIGNATURE:-$output_root/reporting-frontend-runtime-attestation-v1.sig}"
	local container_id compose_project compose_service status health restarting
	local restart_count app_revision image_id image_revision verified_at
	local html_tmp local_asset_tmp public_asset_tmp key_tmp public_tmp
	local attestation_tmp signature_tmp asset_path asset_sha value
	[[ "$backend_revision" =~ ^[0-9a-f]{40}$ &&
		"$frontend_revision" =~ ^[0-9a-f]{40}$ &&
		"$switch_generation" =~ ^[1-9][0-9]*$ &&
		"$challenge" =~ ^[0-9a-f]{64}$ &&
		"$origin" =~ ^https://[^/]+$ ]] || {
		echo 'Exact backend/frontend revisions, switch generation, challenge and canonical HTTPS frontend origin are required.' >&2
		return 1
	}
	frontend_attestation_require_safe_directory "$output_root"
	for value in "$private_key" "$public_key" "$attestation" "$signature"; do
		[[ "$value" == "$output_root/"* && "$(dirname "$value")" == "$output_root" ]] || {
			echo 'Frontend attestation artifacts must stay directly inside the reviewed output directory.' >&2
			return 1
		}
	done
	for value in "$public_key" "$attestation" "$signature"; do
		if [[ -e "$value" || -L "$value" ]]; then
			frontend_attestation_require_safe_file "$value" \
				'Existing frontend attestation artifact'
		fi
	done
	container_id="$(docker ps --no-trunc -q \
		--filter "label=com.docker.compose.project=$FRONTEND_ATTESTATION_PROJECT" \
		--filter "label=com.docker.compose.service=$FRONTEND_ATTESTATION_SERVICE")" || return 1
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Frontend attestation requires exactly one running WinWidget client container.' >&2
		return 1
	}
	compose_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id")"
	compose_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")"
	status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$container_id")"
	restarting="$(docker inspect --format '{{.State.Restarting}}' "$container_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^APP_REVISION=//p')"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	[[ "$compose_project" == "$FRONTEND_ATTESTATION_PROJECT" &&
		"$compose_service" == "$FRONTEND_ATTESTATION_SERVICE" &&
		"$status" == 'running' &&
		( "$health" == 'healthy' || "$health" == 'not-configured' ) &&
		"$restarting" == 'false' && "$restart_count" == '0' &&
		"$app_revision" == "$frontend_revision" &&
		"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$image_revision" == "$app_revision" ]] || {
		echo 'Frontend container/image runtime identity is unsafe.' >&2
		return 1
	}
	frontend_attestation_scan_image_contract "$image_id" || {
		echo 'Frontend image does not contain the exact Reporting API contract.' >&2
		return 1
	}
	html_tmp="$(mktemp "$output_root/.reporting-frontend-html.XXXXXX")"
	local_asset_tmp="$(mktemp "$output_root/.reporting-frontend-local-asset.XXXXXX")"
	public_asset_tmp="$(mktemp "$output_root/.reporting-frontend-public-asset.XXXXXX")"
	key_tmp="$output_root/.reporting-frontend-private-key.$$"
	public_tmp="$output_root/.reporting-frontend-public-key.$$"
	attestation_tmp="$output_root/.reporting-frontend-attestation.$$"
	signature_tmp="$output_root/.reporting-frontend-signature.$$"
	trap 'rm -f -- "$html_tmp" "$local_asset_tmp" "$public_asset_tmp" "$key_tmp" "$public_tmp" "$attestation_tmp" "$signature_tmp"' EXIT
	curl -fsS --connect-timeout 2 --max-time 10 \
		http://127.0.0.1:3000/ -o "$html_tmp"
	curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 5 --max-time 20 \
		"$origin/" >/dev/null
	asset_path="$(frontend_attestation_asset_path "$image_id" "$html_tmp")" || return 1
	[[ "$asset_path" =~ ^/_next/static/[A-Za-z0-9._/-]+$ ]] || return 1
	curl -fsS --connect-timeout 2 --max-time 10 \
		"http://127.0.0.1:3000$asset_path" -o "$local_asset_tmp"
	curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 5 --max-time 20 \
		"$origin$asset_path" -o "$public_asset_tmp"
	asset_sha="$(frontend_attestation_sha256 "$local_asset_tmp")"
	[[ "$asset_sha" == "$(frontend_attestation_sha256 "$public_asset_tmp")" ]] || {
		echo 'Public frontend asset does not match the inspected local runtime.' >&2
		return 1
	}
	if [[ ! -e "$private_key" && ! -L "$private_key" ]]; then
		(umask 077; openssl genpkey -algorithm ED25519 -out "$key_tmp")
		chown 0:0 "$key_tmp"
		chmod 600 "$key_tmp"
		mv "$key_tmp" "$private_key"
	fi
	frontend_attestation_require_safe_file "$private_key" 'Frontend attestation private key'
	(umask 077; openssl pkey -in "$private_key" -pubout -out "$public_tmp")
	verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "BACKEND_REVISION=$backend_revision" \
		-e "FRONTEND_REVISION=$frontend_revision" \
		-e "SWITCH_GENERATION=$switch_generation" \
		-e "FRONTEND_ORIGIN=$origin" -e "CHALLENGE=$challenge" \
		-e "CONTAINER_ID=$container_id" -e "IMAGE_ID=$image_id" \
		-e "IMAGE_REVISION=$image_revision" -e "STATUS=$status" \
		-e "HEALTH=$health" -e "RESTARTING=$restarting" \
		-e "RESTART_COUNT=$restart_count" -e "ASSET_PATH=$asset_path" \
		-e "ASSET_SHA=$asset_sha" -e "VERIFIED_AT=$verified_at" \
		--entrypoint node "$image_id" -e '
const value = {
  version: 1,
  backendRevision: process.env.BACKEND_REVISION,
  frontendRevision: process.env.FRONTEND_REVISION,
  switchGeneration: process.env.SWITCH_GENERATION,
  origin: process.env.FRONTEND_ORIGIN,
  challenge: process.env.CHALLENGE,
  composeProject: "winwidget",
  composeService: "client",
  containerId: process.env.CONTAINER_ID,
  imageId: process.env.IMAGE_ID,
  appRevision: process.env.FRONTEND_REVISION,
  imageRevision: process.env.IMAGE_REVISION,
  status: process.env.STATUS,
  health: process.env.HEALTH,
  restarting: process.env.RESTARTING === "true",
  restartCount: Number(process.env.RESTART_COUNT),
  contractScan: true,
  legacyContractAbsent: true,
  localHttp: true,
  publicHttp: true,
  assetPath: process.env.ASSET_PATH,
  assetSha256: process.env.ASSET_SHA,
  verifiedAt: process.env.VERIFIED_AT,
};
process.stdout.write(`${JSON.stringify(value)}\n`);
' >"$attestation_tmp"
	(umask 077; openssl pkeyutl -sign -inkey "$private_key" -rawin \
		-in "$attestation_tmp" -out "$signature_tmp")
	openssl pkeyutl -verify -pubin -inkey "$public_tmp" -rawin \
		-in "$attestation_tmp" -sigfile "$signature_tmp" >/dev/null
	for value in "$public_tmp" "$attestation_tmp" "$signature_tmp"; do
		chown 0:0 "$value"
		chmod 600 "$value"
	done
	mv -f "$public_tmp" "$public_key"
	mv -f "$attestation_tmp" "$attestation"
	mv -f "$signature_tmp" "$signature"
	frontend_attestation_require_safe_file "$public_key" 'Frontend attestation public key'
	frontend_attestation_require_safe_file "$attestation" 'Frontend runtime attestation'
	frontend_attestation_require_safe_file "$signature" 'Frontend runtime attestation signature'
	openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$attestation" -sigfile "$signature" >/dev/null
	printf 'frontend_revision=%s\n' "$frontend_revision"
	printf 'frontend_runtime_challenge=%s\n' "$challenge"
	printf 'frontend_runtime_attestation_sha256=%s\n' \
		"$(frontend_attestation_sha256 "$attestation")"
	printf 'frontend_runtime_signature_sha256=%s\n' \
		"$(frontend_attestation_sha256 "$signature")"
	printf 'frontend_runtime_public_key_sha256=%s\n' \
		"$(frontend_attestation_sha256 "$public_key")"
)

frontend_attestation_self_test() (
	set -Eeuo pipefail
	local root source_text private_key public_key payload signature
	source_text="$(declare -f frontend_attestation_generate frontend_attestation_scan_image_contract frontend_attestation_asset_path)"
	[[ "$source_text" == *'com.docker.compose.project'* &&
		"$source_text" == *'com.docker.compose.service'* &&
		"$source_text" == *'REPORTING_FRONTEND_REVISION'* &&
		"$source_text" == *'/admin/reporting/daily-summary/settings'* &&
		"$source_text" == *'/statistics/registrations-by-month'* &&
		"$source_text" == *'/_next/static/'* &&
		"$source_text" == *'openssl genpkey -algorithm ED25519'* &&
		"$source_text" == *'openssl pkeyutl -sign'* &&
		"$source_text" == *'openssl pkeyutl -verify'* ]] || {
		echo 'Frontend runtime attestation self-test found a missing runtime/signature guard.' >&2
		return 1
	}
	root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-frontend-attestation.XXXXXX")"
	trap 'rm -rf -- "$root"' EXIT
	private_key="$root/private.pem"
	public_key="$root/public.pem"
	payload="$root/payload.json"
	signature="$root/payload.sig"
	openssl genpkey -algorithm ED25519 -out "$private_key" >/dev/null 2>&1
	openssl pkey -in "$private_key" -pubout -out "$public_key"
	printf '{"test":true}\n' >"$payload"
	openssl pkeyutl -sign -inkey "$private_key" -rawin \
		-in "$payload" -out "$signature"
	openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$payload" -sigfile "$signature" >/dev/null
	printf '{"test":false}\n' >"$payload"
	if openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$payload" -sigfile "$signature" >/dev/null 2>&1; then
		echo 'Frontend runtime attestation self-test accepted a mutated payload.' >&2
		return 1
	fi
	echo 'Reporting cross-VPS frontend runtime attestation contracts passed.'
)

case "${1:-}" in
--self-test)
	[[ $# == 1 ]] || exit 1
	frontend_attestation_self_test
	;;
'')
	frontend_attestation_generate
	;;
*)
	echo "Usage: $0 [--self-test]" >&2
	exit 1
	;;
esac
