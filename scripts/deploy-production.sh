#!/usr/bin/env bash

set -euo pipefail

support_steady_expected_lifecycle_phase() {
	case "${1:-}" in
	true) printf 'forward-only\n' ;;
	false) printf 'complete\n' ;;
	*) return 1 ;;
	esac
}

support_steady_ownership_revision_from_marker() {
	[[ "$#" -eq 2 ]] || return 1
	local marker="$1"
	local expected_phase
	expected_phase="$(support_steady_expected_lifecycle_phase "$2")" || return 1
	[[ -f "$marker" && ! -L "$marker" ]] || return 1
	awk -F= -v expected_phase="$expected_phase" '
		$1 !~ /^(version|phase|ownership_revision|cleanup_revision|volume|image_id|database_id|database_system_identifier|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] != expected_phase ||
				seen["ownership_revision"] != 1 || value["ownership_revision"] !~ /^[0-9a-f]{40}$/ ||
				seen["cleanup_revision"] != 1 || value["cleanup_revision"] !~ /^(pending|[0-9a-f]{40})$/ ||
				seen["volume"] != 1 || value["volume"] !~ /^[A-Za-z0-9][A-Za-z0-9_.-]+$/ ||
				seen["image_id"] != 1 || value["image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["database_id"] != 1 || value["database_id"] !~ /^[0-9a-f-]{36}$/ ||
				seen["database_system_identifier"] != 1 || value["database_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				seen["updated_at"] != 1 || value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
			print value["ownership_revision"]
		}
	' "$marker"
}

run_support_first_cutover_contract_self_test() {
	local self_test_directory marker revision
	self_test_directory="$(
		mktemp -d "${TMPDIR:-/tmp}/winwidget-support-first-cutover.XXXXXX"
	)"
	marker="$self_test_directory/lifecycle"
	revision='0123456789abcdef0123456789abcdef01234567'
	trap 'rm -f "$marker"; rmdir "$self_test_directory"' RETURN

	write_marker() {
		printf '%s\n' \
			'version=1' \
			"phase=$1" \
			"ownership_revision=$revision" \
			'cleanup_revision=pending' \
			'volume=winwidget-support-postgres' \
			'image_id=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
			'database_id=01234567-89ab-cdef-0123-456789abcdef' \
			'database_system_identifier=123456789' \
			'updated_at=2026-08-25T00:00:00Z' >"$marker"
	}

	write_marker complete
	[[ "$(support_steady_ownership_revision_from_marker "$marker" false)" == "$revision" ]]
	if support_steady_ownership_revision_from_marker "$marker" true >/dev/null 2>&1; then
		echo 'Support first-cutover contract accepted a complete marker in special mode.' >&2
		return 1
	fi
	write_marker forward-only
	[[ "$(support_steady_ownership_revision_from_marker "$marker" true)" == "$revision" ]]
	if support_steady_ownership_revision_from_marker "$marker" false >/dev/null 2>&1; then
		echo 'Routine Support deploy accepted a forward-only marker.' >&2
		return 1
	fi
	printf '%s\n' 'phase=forward-only' >>"$marker"
	if support_steady_ownership_revision_from_marker "$marker" true >/dev/null 2>&1; then
		echo 'Support first-cutover contract accepted duplicate lifecycle anchors.' >&2
		return 1
	fi

	printf 'support_first_cutover_contract_self_test=passed\n'
}

validate_routine_database_restore_create_gate() {
	local env_file="$1"
	local matching_lines

	matching_lines="$(
		LC_ALL=C grep -Ec '^DATABASE_RESTORE_PRODUCTION_ENABLED=' "$env_file" || true
	)"
	if [[ "$matching_lines" != '1' ]]; then
		echo 'Routine production deployment requires exactly one literal DATABASE_RESTORE_PRODUCTION_ENABLED=false line.' >&2
		return 1
	fi
	if LC_ALL=C grep -Fxq 'DATABASE_RESTORE_PRODUCTION_ENABLED=false' "$env_file"; then
		return 0
	fi
	if LC_ALL=C grep -Fxq 'DATABASE_RESTORE_PRODUCTION_ENABLED=true' "$env_file"; then
		echo 'Routine production deployment rejects DATABASE_RESTORE_PRODUCTION_ENABLED=true. Use the separate reviewed restore-control action.' >&2
		return 1
	fi

	echo 'Routine production deployment requires the literal DATABASE_RESTORE_PRODUCTION_ENABLED=false line.' >&2
	return 1
}

run_database_restore_create_gate_self_test() {
	local self_test_directory
	local false_env
	local true_env
	local invalid_env
	local rejection

	self_test_directory="$(
		mktemp -d "${TMPDIR:-/tmp}/winwidget-restore-create-gate.XXXXXX"
	)"
	false_env="$self_test_directory/false.env"
	true_env="$self_test_directory/true.env"
	invalid_env="$self_test_directory/invalid.env"
	trap 'rm -f "$false_env" "$true_env" "$invalid_env"; rmdir "$self_test_directory"' RETURN

	printf '%s\n' 'DATABASE_RESTORE_PRODUCTION_ENABLED=false' >"$false_env"
	printf '%s\n' 'DATABASE_RESTORE_PRODUCTION_ENABLED=true' >"$true_env"
	printf '%s\n' 'DATABASE_RESTORE_PRODUCTION_ENABLED= false' >"$invalid_env"

	validate_routine_database_restore_create_gate "$false_env"
	if rejection="$(
		validate_routine_database_restore_create_gate "$true_env" 2>&1
	)"; then
		echo 'Database restore create-gate self-test accepted true.' >&2
		return 1
	fi
	if [[ "$rejection" != *'separate reviewed restore-control action'* ]]; then
		echo 'Database restore create-gate self-test lost the reviewed-action guidance.' >&2
		return 1
	fi
	if validate_routine_database_restore_create_gate "$invalid_env" >/dev/null 2>&1; then
		echo 'Database restore create-gate self-test accepted a non-literal false value.' >&2
		return 1
	fi

	printf 'database_restore_routine_create_gate=passed\n'
}

run_billing_routine_image_gate_self_test() {
	local self_test_node
	self_test_node="$(type -P node 2>/dev/null || true)"
	[[ -n "$self_test_node" && -x "$self_test_node" ]] || {
		echo 'Billing routine image-gate self-test requires host Node.' >&2
		return 1
	}
	"$self_test_node" - "${BASH_SOURCE[0]}" <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const absent = source.indexOf("case \"$billing_database_phase\" in\nabsent)");
const automaticDefer = source.indexOf(
  'Automatic backend revision $deploy_revision is verified but Billing first rollout is deferred.',
  absent,
);
const absentExit = source.indexOf('\n\t\texit 0', automaticDefer);
const prepared = source.indexOf(
  'prepared | source-frozen | imported | pre-backups-created |',
  absent,
);
const routeMarkerGate = source.indexOf('$1 == "route_sha256"', prepared);
const imageGate = source.indexOf(
  'billing_database_require_pinned_candidate_images || {',
  prepared,
);
const build = source.indexOf('compose_target build --provenance=false', imageGate);
const verifyAgain = source.indexOf(
  'Pinned historical Core/Billing candidate images changed during the full build.',
  build,
);
if ([absent, automaticDefer, absentExit, prepared, routeMarkerGate, imageGate,
    build, verifyAgain]
    .some(index => index < 0) ||
    !(absent < automaticDefer && automaticDefer < absentExit &&
      absentExit < prepared && prepared < routeMarkerGate &&
      routeMarkerGate < imageGate && imageGate < build && build < verifyAgain)) {
  process.exit(1);
}
const buildEnd = source.indexOf(
  'billing_database_require_pinned_candidate_images || {',
  build,
);
const buildBlock = source.slice(build, buildEnd);
if (/\n\s+(api|billing-api)\s*(?:\\)?\n/.test(buildBlock)) process.exit(1);
NODE
	printf 'billing_routine_image_gate_self_test=passed\n'
}

run_rabbitmq_routine_provisioning_self_test() {
	local script_path cutover_path provision_source routine_source
	local image_resolver_source topology_provision_source compose_guard_source self_test_node
	script_path="${BASH_SOURCE[0]}"
	cutover_path="$(dirname -- "$script_path")/platform-cutover-production.sh"
	[[ -f "$cutover_path" && ! -L "$cutover_path" ]] || {
		echo 'RabbitMQ routine provisioning self-test requires the Platform cutover source.' >&2
		return 1
	}
	provision_source="$(awk '
		/^provision_rabbitmq_user\(\) \{/ { capture = 1 }
		/^provision_campaigns_rabbitmq_topic_permissions\(\) \{/ { capture = 0 }
		capture { print }
	' "$script_path")"
	routine_source="$(<"$script_path")"
	image_resolver_source="$(awk '
		/^platform_cutover_expected_release_image_id\(\) \{/ { capture = 1 }
		/^platform_cutover_assert_release_image_id\(\) \{/ { capture = 0 }
		capture { print }
	' "$cutover_path")"
	topology_provision_source="$(awk '
		/^platform_cutover_provision_platform_admin_audit_topology\(\) \{/ { capture = 1 }
		/^platform_cutover_assert_integration_worker_permissions\(\) \{/ { capture = 0 }
		capture { print }
	' "$cutover_path")"
	compose_guard_source="$(awk '
		/^routine_compose_starts_integration_worker\(\) \{/ { capture = 1 }
		/^readonly CORE_NOTIFICATION_DELIVERY_OUTCOME_ROUTING_KEY=/ { capture = 0 }
		capture { print }
	' "$script_path")"

	[[ "$provision_source" == *'if ! RABBITMQ_ADMIN_USER='* &&
		"$provision_source" == *'--env RABBITMQ_ADMIN_PASSWORD'* &&
		"$provision_source" == *'--env RABBITMQ_PROVISION_PASSWORD_BASE64'* &&
		"$provision_source" == *'const adminConnection = await connectRabbitMq('*'const response = await fetch('*'/api/users/'*'const targetConnection = await connectRabbitMq('*'rabbitmqctl set_permissions'* &&
		"$provision_source" == *'JSON.stringify({'*'password: targetPassword'*'tags: value("RABBITMQ_PROVISION_TAG")'* &&
		"$provision_source" != *'rabbitmqctl add_user'* &&
		"$provision_source" != *'rabbitmqctl change_password'* &&
		"$provision_source" != *'rabbitmqctl authenticate_user'* &&
		"$provision_source" != *'--env "RABBITMQ_ADMIN_PASSWORD='* &&
		"$provision_source" != *'--env "RABBITMQ_PROVISION_PASSWORD_BASE64='* ]] || {
		echo 'RabbitMQ routine credential transport contract is not fail-closed.' >&2
		return 1
	}
	[[ "$routine_source" == *'routine_compose_starts_integration_worker() {'*'up | start | restart'*'integration-worker)'* &&
		"$routine_source" == *'routine_require_platform_admin_audit_topology() {'*'platform_cutover_provision_platform_admin_audit_topology'*'platform_cutover_assert_platform_admin_audit_topology'* &&
		"$routine_source" == *'compose_target() {'*'routine_compose_starts_integration_worker "$@"'*'routine_require_platform_admin_audit_topology || return 1'*'docker compose --project-name "$target_project"'* &&
		"$routine_source" == *'compose_notification_cutover() {'*'routine_compose_starts_integration_worker "$@"'*'routine_require_platform_admin_audit_topology || return 1'*'docker compose --project-name "$NOTIFICATION_DELIVERY_CUTOVER_PROJECT"'* &&
		"$routine_source" == *'if [[ "$service" == integration-worker ]] &&'*'routine_require_platform_admin_audit_topology'*'docker start "$container_id"'* &&
		"$routine_source" == *'if [[ "$service" == integration-worker ]]; then'*'routine_require_platform_admin_audit_topology'*'docker start "$container_id"'* &&
		"$routine_source" == *'if [[ -n "$first_cutover_legacy_worker_id" ]]'*'routine_require_platform_admin_audit_topology'*'docker start "$first_cutover_legacy_worker_id"'* ]] || {
		echo 'RabbitMQ Platform admin-audit ordering guard is incomplete.' >&2
		return 1
	}
	[[ "$image_resolver_source" == *'core) key=core_api_image_id'*'if platform_cutover_receipt_is_present'*'platform_cutover_billing_readiness_value "$key"'* &&
		"$image_resolver_source" == *'platform_cutover_validate_archived_readiness_receipt'*'platform_cutover_receipt_value_from_file "$archive" "$key"'*'platform_cutover_assert_phase_a_artifacts_retired'* &&
		"$image_resolver_source" == *'core) image="winwidget-api:git-$EXPECTED_REVISION"'*'platform_database_docker image inspect --format'*'{{.Id}}'*'"$image"'* &&
		"$topology_provision_source" == *'image="$(platform_cutover_expected_release_image_id core)"'*'platform_cutover_assert_release_image_id core "$image"'*'--entrypoint node "$image"'*'platform_cutover_assert_platform_admin_audit_topology'* &&
		"$topology_provision_source" != *'--entrypoint node "winwidget-api:'* ]] || {
		echo 'RabbitMQ Platform topology image identity contract is not immutable.' >&2
		return 1
	}
	(
		eval "$image_resolver_source"
		local mode='before-receipt'
		local expected_revision='0123456789abcdef0123456789abcdef01234567'
		local current_image='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		local receipt_image='sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
		# The extracted resolver reads these dynamic-scope fixtures through eval.
		# shellcheck disable=SC2034
		local platform_phase_a_intent='/fixture/.platform-phase-a-intent-v1'
		# shellcheck disable=SC2034
		local platform_phase_a_env_artifact='/fixture/.platform-phase-a-env-v1'
		EXPECTED_REVISION="$expected_revision"
		platform_cutover_receipt_is_present() { [[ "$mode" == after-receipt ]]; }
		platform_cutover_validate_billing_readiness_receipt() { return 0; }
		platform_cutover_billing_readiness_value() {
			case "$1" in
			revision) printf '%s\n' "$expected_revision" ;;
			core_api_image_id) printf '%s\n' "$receipt_image" ;;
			*) return 1 ;;
			esac
		}
		platform_cutover_current_phase() {
			[[ "$mode" == after-archive ]] && printf 'complete\n' || printf 'absent\n'
		}
		platform_cutover_validate_archived_readiness_receipt() { [[ "$mode" == after-archive ]]; }
		platform_cutover_archived_readiness_receipt() { printf '/fixture/archive.receipt\n'; }
		platform_cutover_marker_value() { [[ "$1" == revision ]] && printf '%s\n' "$expected_revision"; }
		platform_cutover_receipt_value_from_file() {
			[[ "$1" == /fixture/archive.receipt && "$2" == core_api_image_id ]] || return 1
			printf '%s\n' "$receipt_image"
		}
		platform_cutover_assert_phase_a_artifacts_retired() { [[ "$mode" == after-archive ]]; }
		platform_cutover_fail() { return 1; }
		platform_database_docker() {
			[[ "$mode" =~ ^(before-receipt|future-release)$ && "$1" == image && "$2" == inspect && "$3" == --format &&
				"$4" == '{{.Id}}' && "$5" == "winwidget-api:git-$expected_revision" ]] || return 1
			printf '%s\n' "$current_image"
		}
		[[ "$(platform_cutover_expected_release_image_id core)" == "$current_image" ]] || return 1
		mode='after-receipt'
		[[ "$(platform_cutover_expected_release_image_id core)" == "$receipt_image" ]] || return 1
		mode='after-archive'
		[[ "$(platform_cutover_expected_release_image_id core)" == "$receipt_image" ]] || return 1
		mode='future-release'
		[[ "$(platform_cutover_expected_release_image_id core)" == "$current_image" ]] || return 1
	) || {
		echo 'RabbitMQ Platform topology image resolution fixture failed.' >&2
		return 1
	}
	[[ "$(grep -Ec '^[[:space:]]*docker compose ' "$script_path")" == 2 ]] &&
		! grep -Eq '^[[:space:]]*docker restart ' "$script_path" || {
		echo 'RabbitMQ Platform ordering has a direct Docker bypass.' >&2
		return 1
	}
	(
		eval "$compose_guard_source"
		local trace='' provision_result=0
		target_project=winwidget
		NOTIFICATION_DELIVERY_CUTOVER_PROJECT=winwidget-notification-telegram-cutover
		ENV_FILE=/fixture.env
		COMPOSE_FILE=/fixture.yml
		platform_cutover_provision_platform_admin_audit_topology() {
			trace+='P'
			return "$provision_result"
		}
		platform_cutover_assert_platform_admin_audit_topology() { trace+='A'; }
		docker() { trace+='D'; }
		compose_target up -d --no-deps --force-recreate integration-worker || return 1
		[[ "$trace" == PAD ]] || return 1
		trace=''
		compose_target ps --status running -q integration-worker || return 1
		[[ "$trace" == D ]] || return 1
		trace=''
		compose_notification_cutover restart integration-worker || return 1
		[[ "$trace" == PAD ]] || return 1
		trace=''
		provision_result=1
		! compose_target up -d integration-worker || return 1
		[[ "$trace" == P ]] || return 1
	) || {
		echo 'RabbitMQ Platform ordering runtime fixture failed.' >&2
		return 1
	}
	self_test_node="$(type -P node 2>/dev/null || true)"
	[[ -n "$self_test_node" && -x "$self_test_node" ]] || {
		echo 'RabbitMQ routine provisioning self-test requires host Node.' >&2
		return 1
	}
	"$self_test_node" - "$script_path" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(process.argv[2], "utf8");
const functionStart = source.indexOf("\nprovision_rabbitmq_user() {");
const scriptStart = source.indexOf('const amqp = require("amqplib");', functionStart);
const scriptEnd = source.indexOf("\n'; then", scriptStart);
assert(functionStart >= 0 && scriptStart > functionStart && scriptEnd > scriptStart);
const provisioningScript = source.slice(scriptStart, scriptEnd);
const adminPassword = "a".repeat(40);
const targetPassword = "b".repeat(40);

async function runFixture({ adminFails = false, managementStatus = 204 } = {}) {
  const events = [];
  const errors = [];
  let connectionAttempt = 0;
  const environment = {
    RABBITMQ_ADMIN_USER: "admin-user",
    RABBITMQ_ADMIN_PASSWORD: adminPassword,
    RABBITMQ_MANAGEMENT_URL: "http://127.0.0.1:15672",
    RABBITMQ_PROVISION_USER: "target-user",
    RABBITMQ_PROVISION_PASSWORD_BASE64: Buffer.from(targetPassword).toString("base64"),
    RABBITMQ_PROVISION_VHOST: "winwidget",
    RABBITMQ_PROVISION_TAG: "administrator,monitoring",
  };
  const sandbox = {
    AbortSignal,
    Buffer,
    process: {
      env: environment,
      exitCode: undefined,
      stderr: { write: message => errors.push(message) },
    },
    require(name) {
      assert.equal(name, "amqplib");
      return {
        async connect(options) {
          connectionAttempt += 1;
          const role = connectionAttempt === 1 ? "admin" : "target";
          events.push(`connect:${role}`);
          if (role === "admin") {
            assert.equal(options.username, environment.RABBITMQ_ADMIN_USER);
            assert.equal(options.password, environment.RABBITMQ_ADMIN_PASSWORD);
            if (adminFails) throw new Error("rejected");
          } else {
            assert.equal(options.username, environment.RABBITMQ_PROVISION_USER);
            assert.equal(options.password, targetPassword);
          }
          assert.equal(options.vhost, environment.RABBITMQ_PROVISION_VHOST);
          return { close: async () => events.push(`close:${role}`) };
        },
      };
    },
    async fetch(url, options) {
      events.push("fetch");
      assert.equal(
        url,
        "http://127.0.0.1:15672/api/users/target-user",
      );
      assert.equal(options.method, "PUT");
      assert.equal(options.redirect, "error");
      assert.equal(
        Buffer.from(options.headers.authorization.slice(6), "base64").toString("utf8"),
        `${environment.RABBITMQ_ADMIN_USER}:${environment.RABBITMQ_ADMIN_PASSWORD}`,
      );
      assert.deepEqual(JSON.parse(options.body), {
        password: targetPassword,
        tags: "administrator,monitoring",
      });
      return { status: managementStatus };
    },
  };
  await vm.runInNewContext(provisioningScript, sandbox);
  return { errors, events, exitCode: sandbox.process.exitCode };
}

(async () => {
  const invalidAdmin = await runFixture({ adminFails: true });
  assert.deepEqual(invalidAdmin.events, ["connect:admin"]);
  assert.deepEqual(invalidAdmin.errors, ["RabbitMQ credential provisioning failed\n"]);
  assert.equal(invalidAdmin.exitCode, 1);

  const rejectedUpdate = await runFixture({ managementStatus: 403 });
  assert.deepEqual(rejectedUpdate.events, ["connect:admin", "close:admin", "fetch"]);
  assert.deepEqual(rejectedUpdate.errors, ["RabbitMQ credential provisioning failed\n"]);
  assert.equal(rejectedUpdate.exitCode, 1);

  const success = await runFixture();
  assert.deepEqual(success.events, [
    "connect:admin",
    "close:admin",
    "fetch",
    "connect:target",
    "close:target",
  ]);
  assert.deepEqual(success.errors, []);
  assert.equal(success.exitCode, undefined);
})().catch(() => process.exit(1));
NODE
	printf 'rabbitmq_routine_provisioning_self_test=passed\n'
}

gateway_route_manifest_policy_validator_source() {
	cat <<'NODE'
function validateGatewayRouteManifest(config, reportingPolicy, billingPolicy, identityPolicy, platformPolicy) {
  const routes = config?.routes;
  if (!Array.isArray(routes)) throw new Error('Gateway routes are unavailable');

  const routeMatches = (route, id, pathPrefix, upstreamOrigin, authPolicy, timeoutMs) =>
    route?.id === id &&
    route.pathPrefix === pathPrefix &&
    route.upstreamUrl?.origin === upstreamOrigin &&
    route.authPolicy === authPolicy &&
    route.timeoutMs === timeoutMs;
  const databaseRestores = routes.find(route => route.id === 'database-restores');
  const campaigns = routes.find(route => route.id === 'campaigns');
  const reporting = routes.find(route => route.id === 'reporting');
  const supportWebhook = routes.find(route => route.id === 'support-webhook');
  const supportAdmin = routes.find(route => route.id === 'support-admin');
  const monolith = routes.find(route => route.id === 'monolith');
  const widgetRoutes = [
    ['widgets-admin', '/api/v1/widgets/admin', 'required'],
    ['widgets-management', '/api/v1/widgets', 'required'],
    ['quizzes-management', '/api/v1/quizzes', 'required'],
    ['callbacks-management', '/api/v1/callbacks', 'required'],
    ['countdown-timers-management', '/api/v1/countdown-timers', 'required'],
    ['stop-offers-management', '/api/v1/stop-offers', 'required'],
    ['online-consultants-management', '/api/v1/online-consultants', 'required'],
    ['calculators-management', '/api/v1/calculators', 'required'],
    ['widget-settings', '/api/v1/widget-settings', 'required'],
    ['widget-runtime', '/api/v1/widget-runtime', 'required'],
    ['widget-public', '/api/v1/widget', 'optional'],
    ['quiz-public', '/api/v1/quiz', 'optional'],
    ['callback-public', '/api/v1/callback', 'optional'],
    ['countdown-timer-public', '/api/v1/countdown-timer', 'optional'],
    ['stop-offer-public', '/api/v1/stop-offer', 'optional'],
    ['online-consultant-public', '/api/v1/online-consultant', 'optional'],
    ['calculator-public', '/api/v1/calculator', 'optional'],
    ['widget-events', '/api/v1/widget-events', 'optional'],
  ];
  const billingRoutes = [
    ['billing-payments', '/api/v1/payments', 'optional'],
    ['billing-subscriptions', '/api/v1/subscriptions', 'optional'],
    ['billing-tariff-prices', '/api/v1/tariff-prices', 'optional'],
    ['billing-affiliate', '/api/v1/affiliate', 'optional'],
    ['billing-settings-public', '/api/v1/billing-settings/public', 'optional'],
    ['billing-settings-admin', '/api/v1/billing-settings/admin', 'required'],
  ];
  const identityRoutes = [
    ['identity-auth', '/api/v1/auth'],
    ['identity-users', '/api/v1/users'],
    ['identity-telegram-auth', '/api/v1/telegram-auth'],
    ['identity-info-webhook', '/api/v1/telegram-bot/webhook'],
  ];
  const platformRoutes = [
    ['platform-site-settings', '/api/v1/site-settings'],
    ['platform-legal-pages', '/api/v1/legal-pages'],
    ['platform-home-page-content', '/api/v1/home-page-content'],
  ];
  const widgetsInvalid = widgetRoutes.some(([id, pathPrefix, authPolicy]) =>
    !routeMatches(
      routes.find(route => route.id === id),
      id,
      pathPrefix,
      'http://127.0.0.1:4700',
      authPolicy,
      60000,
    ),
  ) || routes.filter(
    route => route.upstreamUrl?.origin === 'http://127.0.0.1:4700',
  ).length !== widgetRoutes.length;
  const billingPrefixes = new Set(billingRoutes.map(([, pathPrefix]) => pathPrefix));
  const billingIds = new Set(billingRoutes.map(([id]) => id));
  const billingInvalid = billingPolicy === 'billing'
    ? billingRoutes.some(([id, pathPrefix, authPolicy]) => !routeMatches(
        routes.find(route => route.id === id),
        id,
        pathPrefix,
        'http://127.0.0.1:4800',
        authPolicy,
        30000,
      ) || routes.indexOf(routes.find(route => route.id === id)) >=
        routes.indexOf(monolith)) || routes.filter(
        route => route.upstreamUrl?.origin === 'http://127.0.0.1:4800',
      ).length !== billingRoutes.length || routes.filter(route =>
        route.pathPrefix === '/api/v1/billing-settings' ||
        route.pathPrefix?.startsWith('/api/v1/billing-settings/')).length !== 2
    : billingPolicy === 'legacy'
      ? routes.some(route =>
          billingIds.has(route.id) ||
          billingPrefixes.has(route.pathPrefix) ||
          route.upstreamUrl?.origin === 'http://127.0.0.1:4800')
      : true;
  const identityPrefixes = new Set(identityRoutes.map(([, pathPrefix]) => pathPrefix));
  const identityIds = new Set(identityRoutes.map(([id]) => id));
  const identityInvalid = identityPolicy === 'identity'
    ? identityRoutes.some(([id, pathPrefix]) => !routeMatches(
        routes.find(route => route.id === id),
        id,
        pathPrefix,
        'http://127.0.0.1:4900',
        'optional',
        60000,
      )) || routes.filter(
        route => route.upstreamUrl?.origin === 'http://127.0.0.1:4900',
      ).length !== identityRoutes.length
    : identityPolicy === 'legacy'
      ? routes.some(route =>
          identityIds.has(route.id) ||
          identityPrefixes.has(route.pathPrefix) ||
          route.upstreamUrl?.origin === 'http://127.0.0.1:4900')
      : true;
  const platformInvalid = platformPolicy === 'platform'
    ? platformRoutes.some(([id, pathPrefix]) => !routeMatches(
        routes.find(route => route.id === id),
        id,
        pathPrefix,
        'http://127.0.0.1:5000',
        'optional',
        60000,
      ) || routes.indexOf(routes.find(route => route.id === id)) >=
        routes.indexOf(monolith)) || routes.filter(
        route => route.upstreamUrl?.origin === 'http://127.0.0.1:5000',
      ).length !== platformRoutes.length
    : true;
  const commonInvalid =
    !routeMatches(
      databaseRestores,
      'database-restores',
      '/api/v1/dev-tools/database-restores',
      'http://127.0.0.1:4200',
      'required',
      120000,
    ) ||
    !routeMatches(
      campaigns,
      'campaigns',
      '/api/v1/admin/campaigns',
      'http://127.0.0.1:4500',
      'required',
      60000,
    ) ||
    !routeMatches(
      supportWebhook,
      'support-webhook',
      '/api/v1/telegram-bot/support-webhook',
      'http://127.0.0.1:5100',
      'optional',
      10000,
    ) ||
    !routeMatches(
      supportAdmin,
      'support-admin',
      '/api/v1/support/admin',
      'http://127.0.0.1:5100',
      'required',
      60000,
    ) ||
    routes.filter(
      route => route.upstreamUrl?.origin === 'http://127.0.0.1:5100',
    ).length !== 2 ||
    !routeMatches(
      monolith,
      'monolith',
      '/api/v1',
      'http://127.0.0.1:4200',
      'optional',
      60000,
    );
  const expectedRouteCount = 5 + widgetRoutes.length +
    (reportingPolicy === 'reporting' ? 1 : 0) +
    (billingPolicy === 'billing' ? billingRoutes.length : 0) +
    (identityPolicy === 'identity' ? identityRoutes.length : 0) +
    (platformPolicy === 'platform' ? platformRoutes.length : 0);
  const darkInvalid = reportingPolicy === 'dark' &&
    (reporting || routes.some(route =>
      route.pathPrefix === '/api/v1/admin/reporting' ||
      route.upstreamUrl?.origin === 'http://127.0.0.1:4600'));
  const reportingInvalid = reportingPolicy === 'reporting' && !routeMatches(
    reporting,
    'reporting',
    '/api/v1/admin/reporting',
    'http://127.0.0.1:4600',
    'required',
    60000,
  );
  if (
    !['dark', 'reporting'].includes(reportingPolicy) ||
    !['legacy', 'billing'].includes(billingPolicy) ||
    !['legacy', 'identity'].includes(identityPolicy) ||
    platformPolicy !== 'platform' ||
    routes.length !== expectedRouteCount ||
    commonInvalid ||
    widgetsInvalid ||
    billingInvalid ||
    identityInvalid ||
    platformInvalid ||
    darkInvalid ||
    reportingInvalid
  ) {
    throw new Error(
      `Gateway route manifest conflicts with Reporting policy ${reportingPolicy}, Billing policy ${billingPolicy}, Identity policy ${identityPolicy}, and Platform policy ${platformPolicy}`,
    );
  }
}
NODE
}

run_gateway_route_manifest_policy_self_test() {
	local self_test_node validator_source
	self_test_node="$(type -P node 2>/dev/null || true)"
	[[ -n "$self_test_node" && -x "$self_test_node" ]] || {
		echo 'Gateway route-manifest policy self-test requires host Node.' >&2
		return 1
	}
	validator_source="$(gateway_route_manifest_policy_validator_source)"
	"$self_test_node" - "$validator_source" <<'NODE'
const assert = require('node:assert/strict');
const validatorSource = process.argv[2];
eval(validatorSource);

const route = (id, pathPrefix, upstreamOrigin, authPolicy, timeoutMs) => ({
  id,
  pathPrefix,
  upstreamUrl: new URL(upstreamOrigin),
  authPolicy,
  timeoutMs,
});
const common = [
  route('database-restores', '/api/v1/dev-tools/database-restores', 'http://127.0.0.1:4200', 'required', 120000),
  route('campaigns', '/api/v1/admin/campaigns', 'http://127.0.0.1:4500', 'required', 60000),
  route('support-webhook', '/api/v1/telegram-bot/support-webhook', 'http://127.0.0.1:5100', 'optional', 10000),
  route('support-admin', '/api/v1/support/admin', 'http://127.0.0.1:5100', 'required', 60000),
  route('monolith', '/api/v1', 'http://127.0.0.1:4200', 'optional', 60000),
];
const widgets = [
  ['widgets-admin', '/api/v1/widgets/admin', 'required'],
  ['widgets-management', '/api/v1/widgets', 'required'],
  ['quizzes-management', '/api/v1/quizzes', 'required'],
  ['callbacks-management', '/api/v1/callbacks', 'required'],
  ['countdown-timers-management', '/api/v1/countdown-timers', 'required'],
  ['stop-offers-management', '/api/v1/stop-offers', 'required'],
  ['online-consultants-management', '/api/v1/online-consultants', 'required'],
  ['calculators-management', '/api/v1/calculators', 'required'],
  ['widget-settings', '/api/v1/widget-settings', 'required'],
  ['widget-runtime', '/api/v1/widget-runtime', 'required'],
  ['widget-public', '/api/v1/widget', 'optional'],
  ['quiz-public', '/api/v1/quiz', 'optional'],
  ['callback-public', '/api/v1/callback', 'optional'],
  ['countdown-timer-public', '/api/v1/countdown-timer', 'optional'],
  ['stop-offer-public', '/api/v1/stop-offer', 'optional'],
  ['online-consultant-public', '/api/v1/online-consultant', 'optional'],
  ['calculator-public', '/api/v1/calculator', 'optional'],
  ['widget-events', '/api/v1/widget-events', 'optional'],
].map(([id, pathPrefix, authPolicy]) =>
  route(id, pathPrefix, 'http://127.0.0.1:4700', authPolicy, 60000));
const reporting = route(
  'reporting',
  '/api/v1/admin/reporting',
  'http://127.0.0.1:4600',
  'required',
  60000,
);
const billing = [
  ['billing-payments', '/api/v1/payments', 'optional'],
  ['billing-subscriptions', '/api/v1/subscriptions', 'optional'],
  ['billing-tariff-prices', '/api/v1/tariff-prices', 'optional'],
  ['billing-affiliate', '/api/v1/affiliate', 'optional'],
  ['billing-settings-public', '/api/v1/billing-settings/public', 'optional'],
  ['billing-settings-admin', '/api/v1/billing-settings/admin', 'required'],
].map(([id, pathPrefix, authPolicy]) =>
  route(id, pathPrefix, 'http://127.0.0.1:4800', authPolicy, 30000));
const identity = [
  ['identity-auth', '/api/v1/auth'],
  ['identity-users', '/api/v1/users'],
  ['identity-telegram-auth', '/api/v1/telegram-auth'],
  ['identity-info-webhook', '/api/v1/telegram-bot/webhook'],
].map(([id, pathPrefix]) =>
  route(id, pathPrefix, 'http://127.0.0.1:4900', 'optional', 60000));
const platform = [
  ['platform-site-settings', '/api/v1/site-settings'],
  ['platform-legal-pages', '/api/v1/legal-pages'],
  ['platform-home-page-content', '/api/v1/home-page-content'],
].map(([id, pathPrefix]) =>
  route(id, pathPrefix, 'http://127.0.0.1:5000', 'optional', 60000));
const withPlatformBeforeMonolith = routes => {
  const monolithIndex = routes.findIndex(item => item.id === 'monolith');
  assert.notEqual(monolithIndex, -1);
	const monolith = routes[monolithIndex];
  return [
	...routes.filter((_, index) => index !== monolithIndex),
    ...platform,
	monolith,
  ];
};
const accepts = (routes, reportingPolicy, billingPolicy, identityPolicy = 'legacy') =>
  validateGatewayRouteManifest({ routes: withPlatformBeforeMonolith(routes) }, reportingPolicy, billingPolicy, identityPolicy, 'platform');
const rejects = (routes, reportingPolicy, billingPolicy, identityPolicy = 'legacy') => assert.throws(
  () => validateGatewayRouteManifest({ routes }, reportingPolicy, billingPolicy, identityPolicy, 'platform'),
  /Gateway route manifest conflicts/,
);

accepts([...common, ...widgets], 'dark', 'legacy');
accepts([...common, ...widgets, reporting], 'reporting', 'legacy');
accepts([...common, ...widgets, ...billing], 'dark', 'billing');
accepts([...common, ...widgets, reporting, ...billing], 'reporting', 'billing');
accepts([...common, ...widgets, ...identity], 'dark', 'legacy', 'identity');
accepts(
  [...common, ...widgets, reporting, ...billing, ...identity],
  'reporting',
  'billing',
  'identity',
);
accepts(
  [...billing, common[0], common[1], common[2], common[3], reporting, ...widgets, common[4]],
  'reporting',
  'billing',
);
rejects([...common, ...widgets, reporting, ...billing, ...platform], 'reporting', 'legacy');
rejects([...common, ...widgets, reporting, ...billing.slice(0, 3), ...platform], 'reporting', 'billing');
rejects(
  [...common, ...widgets, reporting, ...billing.slice(0, 3), { ...billing[3], authPolicy: 'required' }, ...platform],
  'reporting',
  'billing',
);
rejects(
  withPlatformBeforeMonolith([...common, ...widgets, reporting, ...billing]).map(item =>
    item.id === 'billing-settings-public' ? { ...item, authPolicy: 'required' } : item),
  'reporting',
  'billing',
);
rejects(
  withPlatformBeforeMonolith([...common, ...widgets, reporting, ...billing]).map(item =>
    item.id === 'billing-settings-admin' ? { ...item, authPolicy: 'optional' } : item),
  'reporting',
  'billing',
);
rejects(
  [
    ...withPlatformBeforeMonolith([...common, ...widgets, reporting, ...billing]).slice(0, -1),
    route('billing-settings-alias', '/api/v1/billing-settings', 'http://127.0.0.1:4800', 'optional', 30000),
    common[4],
  ],
  'reporting',
  'billing',
);
rejects(
  [...withPlatformBeforeMonolith([...common, ...widgets, reporting, ...billing]), billing[5]],
  'reporting',
  'billing',
);
rejects(
  [...common, ...widgets, reporting, { ...billing[0], id: 'billing-payment' }, ...billing.slice(1), ...platform],
  'reporting',
  'billing',
);
rejects(
  [...common, ...widgets, reporting, { ...billing[0], timeoutMs: 60000 }, ...billing.slice(1), ...platform],
  'reporting',
  'billing',
);
rejects(
  [
    ...common,
    ...widgets,
    reporting,
    { ...billing[0], upstreamUrl: new URL('http://127.0.0.1:4200') },
    ...billing.slice(1),
    ...platform,
  ],
  'reporting',
  'billing',
);
rejects(
  [...common, ...widgets, reporting, ...billing, ...platform, route('extra', '/extra', 'http://127.0.0.1:4900', 'required', 1000)],
  'reporting',
  'billing',
);
rejects([...common, ...widgets, reporting], 'unsafe', 'legacy');
rejects([...common, ...widgets, reporting], 'reporting', 'unsafe');
rejects([...common, ...widgets, ...identity, ...platform], 'dark', 'legacy', 'legacy');
rejects([...common, ...widgets, ...identity.slice(0, 3), ...platform], 'dark', 'legacy', 'identity');
rejects(
  [...common, ...widgets, ...identity.slice(0, 3), { ...identity[3], authPolicy: 'required' }, ...platform],
  'dark',
  'legacy',
  'identity',
);
rejects([...common, ...widgets, ...platform], 'dark', 'legacy', 'unsafe');
rejects([...common, ...widgets, ...platform.slice(0, 2)], 'dark', 'legacy');
NODE
	printf 'gateway_route_manifest_policy_self_test=passed\n'
}

run_platform_cleanup_routine_gate_self_test() {
	local self_test_node
	self_test_node="$(type -P node 2>/dev/null || true)"
	[[ -n "$self_test_node" && -x "$self_test_node" ]] || {
		echo 'Platform cleanup routine-gate self-test requires host Node.' >&2
		return 1
	}
	"$self_test_node" - "${BASH_SOURCE[0]}" <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const markerIdentity = source.lastIndexOf('platform_database_assert_marker_identity');
const cleanupMigration = source.indexOf(
  "platform_cleanup_migration='20260825000000_remove_legacy_platform_core_source'",
  markerIdentity,
);
const absentDefer = source.indexOf(
  'the destructive Platform Core cleanup is deferred.',
  cleanupMigration,
);
const statusGate = source.indexOf('bash "$platform_cleanup_controller" --status', cleanupMigration);
const markerBinding = source.indexOf(
  'Platform Core cleanup release is not bound to the completed ownership generation and reviewed migration.',
  statusGate,
);
const incompleteDefer = source.indexOf(
  'Automatic backend deployment is deferred while Platform Core cleanup is phase=',
  markerBinding,
);
const ancestryGate = source.indexOf(
  'Routine deployment would downgrade past the completed Platform Core cleanup.',
  incompleteDefer,
);
const dirtyGate = source.indexOf('dirty_files="$(', ancestryGate);
const routineBuild = source.indexOf('compose_target build --provenance=false', dirtyGate);
const routineMigrate = source.indexOf(
  'compose_target --profile migration run --rm --no-deps migrate',
  dirtyGate,
);
if ([markerIdentity, cleanupMigration, absentDefer, statusGate, markerBinding,
    incompleteDefer, ancestryGate, dirtyGate, routineBuild, routineMigrate]
    .some(index => index < 0) ||
    !(markerIdentity < cleanupMigration && cleanupMigration < absentDefer &&
      absentDefer < statusGate && statusGate < markerBinding &&
      markerBinding < incompleteDefer && incompleteDefer < ancestryGate &&
      ancestryGate < dirtyGate && dirtyGate < routineBuild && dirtyGate < routineMigrate)) {
  console.error(JSON.stringify({ markerIdentity, cleanupMigration, absentDefer, statusGate,
    markerBinding, incompleteDefer, ancestryGate, dirtyGate, routineBuild, routineMigrate }));
  process.exit(1);
}
const block = source.slice(cleanupMigration, dirtyGate);
for (const token of [
  'Use the manual platform-cleanup target; routine migrate must not apply the destructive migration.',
  'Resume the exact manual platform-cleanup workflow.',
  '"$platform_cleanup_actual_migration_sha" == "$platform_cleanup_migration_sha"',
  '"$platform_cleanup_ownership" == "$(platform_cutover_marker_value revision)"',
  '"$platform_cleanup_generation" == "$(platform_cutover_marker_value generation)"',
  '"$platform_cleanup_revision" "$deploy_revision"',
]) if (!block.includes(token)) {
  console.error(`missing Platform cleanup routine-gate token: ${token}`);
  process.exit(1);
}
NODE
	printf 'platform_cleanup_routine_gate_self_test=passed\n'
}

if [[ "${1:-}" == '--self-test-database-restore-create-gate' ]]; then
	[[ "$#" -eq 1 ]] || {
		echo 'Database restore create-gate self-test does not accept extra arguments.' >&2
		exit 1
	}
	run_database_restore_create_gate_self_test
	exit 0
fi

if [[ "${1:-}" == '--self-test-billing-routine-image-gate' ]]; then
	[[ "$#" -eq 1 ]] || {
		echo 'Billing routine image-gate self-test does not accept extra arguments.' >&2
		exit 1
	}
	run_billing_routine_image_gate_self_test
	exit 0
fi

if [[ "${1:-}" == '--self-test-gateway-route-manifest-policy' ]]; then
	[[ "$#" -eq 1 ]] || {
		echo 'Gateway route-manifest policy self-test does not accept extra arguments.' >&2
		exit 1
	}
	run_gateway_route_manifest_policy_self_test
	exit 0
fi

if [[ "${1:-}" == '--self-test-rabbitmq-provisioning-contract' ]]; then
	[[ "$#" -eq 1 ]] || {
		echo 'RabbitMQ provisioning self-test does not accept extra arguments.' >&2
		exit 1
	}
	run_rabbitmq_routine_provisioning_self_test
	exit 0
fi

if [[ "${1:-}" == '--self-test-platform-cleanup-routine-gate' ]]; then
	[[ "$#" -eq 1 ]] || {
		echo 'Platform cleanup routine-gate self-test does not accept extra arguments.' >&2
		exit 1
	}
	run_platform_cleanup_routine_gate_self_test
	exit 0
fi

if [[ "${1:-}" == '--self-test-support-first-cutover-contract' ]]; then
	[[ "$#" -eq 1 ]] || {
		echo 'Support first-cutover contract self-test does not accept extra arguments.' >&2
		exit 1
	}
	run_support_first_cutover_contract_self_test
	exit 0
fi

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/v1/health/deployment}"
PUBLIC_HEALTHCHECK_URL="${PUBLIC_HEALTHCHECK_URL:-https://api.winwidget.ru/api/v1/health/deployment}"
READINESS_URL="${READINESS_URL:-http://127.0.0.1:4200/api/v1/health/ready}"
GATEWAY_READINESS_URL="${GATEWAY_READINESS_URL:-http://127.0.0.1:4100/health/ready}"
MAINTENANCE_READINESS_URL="${MAINTENANCE_READINESS_URL:-http://127.0.0.1:4300/health/ready}"
NOTIFICATION_DELIVERY_READINESS_URL="${NOTIFICATION_DELIVERY_READINESS_URL:-http://127.0.0.1:4401/health/ready}"
CAMPAIGNS_READINESS_URL="${CAMPAIGNS_READINESS_URL:-http://127.0.0.1:4500/health/ready}"
REPORTING_READINESS_URL="${REPORTING_READINESS_URL:-http://127.0.0.1:4600/health/ready}"
WIDGETS_READINESS_URL="${WIDGETS_READINESS_URL:-http://127.0.0.1:4700/health/ready}"
BILLING_API_READINESS_URL="${BILLING_API_READINESS_URL:-http://127.0.0.1:4800/health/ready}"
BILLING_SCHEDULER_READINESS_URL="${BILLING_SCHEDULER_READINESS_URL:-http://127.0.0.1:4801/health/ready}"
BILLING_WORKER_READINESS_URL="${BILLING_WORKER_READINESS_URL:-http://127.0.0.1:4802/health/ready}"
BILLING_OUTBOX_READINESS_URL="${BILLING_OUTBOX_READINESS_URL:-http://127.0.0.1:4803/health/ready}"
IDENTITY_API_READINESS_URL="${IDENTITY_API_READINESS_URL:-http://127.0.0.1:4900/health/ready}"
IDENTITY_WORKER_READINESS_URL="${IDENTITY_WORKER_READINESS_URL:-http://127.0.0.1:4901/health/ready}"
IDENTITY_OUTBOX_READINESS_URL="${IDENTITY_OUTBOX_READINESS_URL:-http://127.0.0.1:4902/health/ready}"
SUPPORT_API_READINESS_URL="${SUPPORT_API_READINESS_URL:-http://127.0.0.1:5100/health/ready}"
SUPPORT_WORKER_READINESS_URL="${SUPPORT_WORKER_READINESS_URL:-http://127.0.0.1:5101/health/ready}"
SUPPORT_OUTBOX_READINESS_URL="${SUPPORT_OUTBOX_READINESS_URL:-http://127.0.0.1:5102/health/ready}"
NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-cutover-v1"
NOTIFICATION_DELIVERY_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-telegram-cutover-v1"
NOTIFICATION_DELIVERY_CUTOVER_PROJECT="winwidget-notification-telegram-cutover"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-2}"
support_first_cutover_deploy="${SUPPORT_FIRST_CUTOVER_DEPLOY:-false}"
[[ "$support_first_cutover_deploy" =~ ^(true|false)$ ]] || {
	echo 'SUPPORT_FIRST_CUTOVER_DEPLOY must be true or false.' >&2
	exit 1
}

cd "$APP_ROOT"

server_root="$APP_ROOT/winwidget.ru_server"
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock "full backend deployment"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/core-database-production-guard.sh
source "$server_root/scripts/core-database-production-guard.sh"
# shellcheck source=scripts/reporting-database-lifecycle.sh
source "$server_root/scripts/reporting-database-lifecycle.sh"
# shellcheck source=scripts/reporting-cutover-lifecycle.sh
source "$server_root/scripts/reporting-cutover-lifecycle.sh"
# shellcheck source=scripts/widgets-database-lifecycle.sh
source "$server_root/scripts/widgets-database-lifecycle.sh"
# shellcheck source=scripts/billing-database-lifecycle.sh
source "$server_root/scripts/billing-database-lifecycle.sh"
# shellcheck source=scripts/identity-database-lifecycle.sh
source "$server_root/scripts/identity-database-lifecycle.sh"
# shellcheck source=scripts/platform-database-lifecycle.sh
source "$server_root/scripts/platform-database-lifecycle.sh"
# shellcheck source=scripts/platform-cutover-production.sh
source "$server_root/scripts/platform-cutover-production.sh"
# shellcheck source=scripts/campaigns-contract-migration-guard.sh
source "$server_root/scripts/campaigns-contract-migration-guard.sh"
deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
if [[ "$support_first_cutover_deploy" == 'true' ]]; then
	support_lifecycle_marker="$APP_ROOT/deploy/backend/.support-database-lifecycle-v1"
	support_cutover_marker="$APP_ROOT/deploy/backend/.support-cutover-v1"
	[[ -f "$support_lifecycle_marker" && ! -L "$support_lifecycle_marker" &&
		"$(stat -c '%u:%g:%a' "$support_lifecycle_marker")" == '0:0:600' &&
		-f "$support_cutover_marker" && ! -L "$support_cutover_marker" &&
		"$(stat -c '%u:%g:%a' "$support_cutover_marker")" == '0:0:600' ]] || {
		echo 'Support first-cutover deploy requires the protected lifecycle marker.' >&2
		exit 1
	}
	support_first_cutover_marker_state="$(awk -F= '
		$1 == "phase" { phase=substr($0, index($0, "=") + 1); phases += 1 }
		$1 == "ownership_revision" { revision=substr($0, index($0, "=") + 1); revisions += 1 }
		$1 == "image_id" { image=substr($0, index($0, "=") + 1); images += 1 }
		END {
			if (phases != 1 || revisions != 1 || images != 1 ||
				image !~ /^sha256:[0-9a-f]{64}$/) exit 1
			printf "%s|%s|%s", phase, revision, image
		}
	' "$support_lifecycle_marker")" || exit 1
	IFS='|' read -r support_first_database_phase support_first_database_revision \
		support_first_database_image_id <<<"$support_first_cutover_marker_state"
	support_first_release_state="$(awk -F= '
		$1 !~ /^(version|phase|revision|core_image_id|support_image_id|gateway_image_id|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1]=substr($0, index($0, "=") + 1) }
		END {
			if (seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] != "forward-only" ||
				seen["revision"] != 1 || value["revision"] !~ /^[0-9a-f]{40}$/ ||
				seen["core_image_id"] != 1 || value["core_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["support_image_id"] != 1 || value["support_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["gateway_image_id"] != 1 || value["gateway_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["updated_at"] != 1) exit 1
			printf "%s|%s|%s|%s", value["revision"], value["core_image_id"],
				value["support_image_id"], value["gateway_image_id"]
		}
	' "$support_cutover_marker")" || exit 1
	IFS='|' read -r support_first_release_revision support_first_core_image_id \
		support_first_support_image_id support_first_gateway_image_id \
		<<<"$support_first_release_state"
	[[ "$support_first_database_phase" == 'forward-only' &&
		"$support_first_database_revision" == "$deploy_revision" &&
		"$support_first_release_revision" == "$deploy_revision" &&
		"$support_first_database_image_id" == "$support_first_support_image_id" ]] || {
		echo 'Support first-cutover deploy is allowed only for its exact forward-only revision.' >&2
		exit 1
	}
	for support_first_image_contract in \
		"winwidget-api:git-$deploy_revision|$support_first_core_image_id|nestjs" \
		"winwidget-support:git-$deploy_revision|$support_first_support_image_id|support" \
		"winwidget-api-gateway:git-$deploy_revision|$support_first_gateway_image_id|node"; do
		IFS='|' read -r support_first_image_ref support_first_expected_image_id \
			support_first_expected_user <<<"$support_first_image_contract"
		[[ "$(docker image inspect --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' "$support_first_image_ref")" == \
			"$support_first_expected_image_id|$deploy_revision|$support_first_expected_user" ]] || {
			echo 'Support first-cutover release image identity changed.' >&2
			exit 1
		}
	done
fi
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
if [[ "$deploy_revision" != "$expected_revision" ]]; then
	echo "Deployment revision mismatch: expected $expected_revision, got $deploy_revision" >&2
	exit 1
fi

EXPECTED_REVISION="$expected_revision"
# shellcheck source=scripts/identity-production-env-control.sh
source "$server_root/scripts/identity-production-env-control.sh"
export IDENTITY_EXPECTED_REVISION="$expected_revision"
# These values are populated by the sourced env-control contract above.
# shellcheck disable=SC2154
export IDENTITY_EXPECTED_POSTGRES_IMAGE="$identity_env_postgres_image"
# shellcheck disable=SC2154
export IDENTITY_EXPECTED_INTEGRATION_KINDS="$identity_env_integration_kinds"
# shellcheck disable=SC2154
export IDENTITY_EXPECTED_ADMIN_FILE="$identity_env_admin_password_file"

platform_routes_env_state="$(
	identity_env_node_validate "$ENV_FILE" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const matches = source.split(/\r?\n/).filter(line => line.startsWith("GATEWAY_ROUTES_JSON="));
if (matches.length !== 1) process.exit(1);
let raw = matches[0].slice("GATEWAY_ROUTES_JSON=".length).trim();
if ((raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
const routes = JSON.parse(raw);
const exact = [
  ["platform-site-settings", "/api/v1/site-settings", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-legal-pages", "/api/v1/legal-pages", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-home-page-content", "/api/v1/home-page-content", "http://127.0.0.1:5000", "optional", 60000],
  ["billing-settings-public", "/api/v1/billing-settings/public", "http://127.0.0.1:4800", "optional", 30000],
  ["billing-settings-admin", "/api/v1/billing-settings/admin", "http://127.0.0.1:4800", "required", 30000],
];
if (!Array.isArray(routes)) process.exit(1);
const monolith = routes.findIndex(route => route?.id === "monolith");
const valid = monolith >= 0 && exact.every(([id, pathPrefix, upstreamUrl, authPolicy, timeoutMs]) => {
  const matching = routes.filter(route => route?.id === id);
  if (matching.length !== 1) return false;
  const route = matching[0];
  return route.pathPrefix === pathPrefix &&
    route.upstreamUrl === upstreamUrl &&
    route.authPolicy === authPolicy && route.timeoutMs === timeoutMs &&
    routes.indexOf(route) < monolith;
}) && routes.filter(route => route?.upstreamUrl === "http://127.0.0.1:5000").length === 3 &&
  routes.filter(route => route?.pathPrefix === "/api/v1/billing-settings" ||
    route?.pathPrefix?.startsWith("/api/v1/billing-settings/")).length === 2;
process.stdout.write(valid ? "platform" : "unsafe");
NODE
)" || {
	echo 'Platform Gateway route env contract is invalid.' >&2
	exit 1
}
platform_database_phase="$(platform_database_current_phase)" || {
	echo 'Platform database lifecycle marker is invalid.' >&2
	exit 1
}
platform_cutover_phase="$(platform_cutover_current_phase)" || {
	echo 'Platform ownership lifecycle marker is invalid.' >&2
	exit 1
}
[[ "$platform_routes_env_state" == platform &&
	"$platform_database_phase" == complete &&
	"$platform_cutover_phase" == complete ]] || {
	echo "Full deployment is blocked until Platform routes and both lifecycles are exactly complete: routes=$platform_routes_env_state database=$platform_database_phase ownership=$platform_cutover_phase." >&2
	exit 1
}
platform_database_require_inputs
platform_cutover_validate_marker
[[ "$(platform_cutover_marker_value revision)" == \
	"$(platform_database_marker_value revision)" &&
	"$(platform_cutover_marker_value image_id)" == \
	"$(platform_database_marker_value image_id)" &&
	"$(platform_cutover_marker_value database_id)" == \
	"$(platform_database_marker_value database_id)" &&
	"$(platform_cutover_marker_value database_system_identifier)" == \
	"$(platform_database_marker_value database_system_identifier)" ]] || {
	echo 'Completed Platform database and ownership markers disagree.' >&2
	exit 1
}
for platform_evidence_key in snapshot_sha256 source_fingerprint \
	imported_backup_sha256 active_backup_sha256; do
	[[ "$(platform_cutover_marker_value "$platform_evidence_key")" =~ ^[0-9a-f]{64}$ ]] || {
		echo "Completed Platform marker lacks sealed $platform_evidence_key evidence." >&2
		exit 1
	}
done
[[ "$(platform_cutover_marker_value source_high_watermark)" =~ ^[1-9][0-9]*$ ]] || {
	echo 'Completed Platform marker lacks source high-water evidence.' >&2
	exit 1
}
platform_cutover_assert_phase_a_artifacts_retired || {
	echo 'Full deployment requires canonically retired phase-A artifacts.' >&2
	exit 1
}
git -C "$server_root" merge-base --is-ancestor \
	"$(platform_cutover_marker_value revision)" "$deploy_revision" || {
	echo 'Full deployment would precede the completed Platform ownership revision.' >&2
	exit 1
}
platform_database_assert_marker_identity

platform_cleanup_automatic_prod_push="${PLATFORM_CLEANUP_AUTOMATIC_PROD_PUSH:-${AUTOMATIC_PROD_PUSH:-false}}"
platform_cleanup_migration='20260825000000_remove_legacy_platform_core_source'
platform_cleanup_directory="$server_root/prisma/migrations/$platform_cleanup_migration"
platform_cleanup_migration_file="$platform_cleanup_directory/migration.sql"
platform_cleanup_controller="$server_root/scripts/cleanup-platform-core-source-production.sh"
# Defined by the sourced Platform database lifecycle contract.
# shellcheck disable=SC2154
if [[ -e "$platform_cleanup_directory" || -L "$platform_cleanup_directory" ||
	-e "$platform_core_cleanup_marker" || -L "$platform_core_cleanup_marker" ]]; then
	[[ -d "$platform_cleanup_directory" && ! -L "$platform_cleanup_directory" &&
		-f "$platform_cleanup_migration_file" && ! -L "$platform_cleanup_migration_file" &&
		-f "$platform_cleanup_controller" && ! -L "$platform_cleanup_controller" ]] || {
		echo 'Platform Core cleanup release paths are incomplete or unsafe.' >&2
		exit 1
	}
	if [[ ! -e "$platform_core_cleanup_marker" && ! -L "$platform_core_cleanup_marker" ]]; then
		if [[ "$platform_cleanup_automatic_prod_push" == true ]]; then
			echo "Automatic backend revision $deploy_revision is verified but the destructive Platform Core cleanup is deferred."
			echo 'Use the manual platform-cleanup target after the post-cutover soak and evidence gates pass.'
			exit 0
		fi
		echo 'Routine deployment is blocked for an unstaged Platform Core cleanup release.' >&2
		echo 'Use the manual platform-cleanup target; routine migrate must not apply the destructive migration.' >&2
		exit 1
	fi
	APP_ROOT="$APP_ROOT" SERVER_ROOT="$server_root" EXPECTED_REVISION="$deploy_revision" \
		bash "$platform_cleanup_controller" --status >/dev/null || {
		echo 'Platform Core cleanup marker is invalid.' >&2
		exit 1
	}
	platform_cleanup_state="$(awk -F= -v expected_migration="$platform_cleanup_migration" '
	  $1 == "phase" { phase=substr($0, index($0, "=") + 1); phase_count += 1 }
	  $1 == "ownership_revision" { ownership=substr($0, index($0, "=") + 1); ownership_count += 1 }
	  $1 == "cleanup_revision" { cleanup=substr($0, index($0, "=") + 1); cleanup_count += 1 }
	  $1 == "generation" { generation=substr($0, index($0, "=") + 1); generation_count += 1 }
	  $1 == "migration" { migration=substr($0, index($0, "=") + 1); migration_count += 1 }
	  $1 == "migration_sha256" { migration_sha=substr($0, index($0, "=") + 1); migration_sha_count += 1 }
	  END {
	    if (phase_count != 1 || ownership_count != 1 || cleanup_count != 1 ||
	        generation_count != 1 || migration_count != 1 || migration_sha_count != 1 ||
	        phase !~ /^(preparing|staged|sealing|sealed|forward-only|migrating|applied|verifying|complete)$/ ||
	        ownership !~ /^[0-9a-f]{40}$/ || cleanup !~ /^[0-9a-f]{40}$/ || ownership == cleanup ||
	        generation !~ /^[1-9][0-9]{0,17}$/ || migration != expected_migration ||
	        migration_sha !~ /^[0-9a-f]{64}$/) exit 1
	    printf "%s|%s|%s|%s|%s", phase, ownership, cleanup, generation, migration_sha
	  }
	' "$platform_core_cleanup_marker")" || {
		echo 'Platform Core cleanup marker identity is unreadable.' >&2
		exit 1
	}
	IFS='|' read -r platform_cleanup_phase platform_cleanup_ownership \
		platform_cleanup_revision platform_cleanup_generation platform_cleanup_migration_sha \
		<<<"$platform_cleanup_state"
	platform_cleanup_actual_migration_sha="$(sha256sum "$platform_cleanup_migration_file" | awk 'NR == 1 { print $1 }')"
	[[ "$platform_cleanup_actual_migration_sha" == "$platform_cleanup_migration_sha" &&
		"$platform_cleanup_ownership" == "$(platform_cutover_marker_value revision)" &&
		"$platform_cleanup_generation" == "$(platform_cutover_marker_value generation)" ]] || {
		echo 'Platform Core cleanup release is not bound to the completed ownership generation and reviewed migration.' >&2
		exit 1
	}
	if [[ "$platform_cleanup_phase" != complete ]]; then
		if [[ "$platform_cleanup_automatic_prod_push" == true ]]; then
			echo "Automatic backend deployment is deferred while Platform Core cleanup is phase=$platform_cleanup_phase."
			exit 0
		fi
		echo "Routine deployment is blocked while Platform Core cleanup is phase=$platform_cleanup_phase." >&2
		echo 'Resume the exact manual platform-cleanup workflow.' >&2
		exit 1
	fi
	git -C "$server_root" merge-base --is-ancestor \
		"$platform_cleanup_revision" "$deploy_revision" || {
		echo 'Routine deployment would downgrade past the completed Platform Core cleanup.' >&2
		exit 1
	}
fi

dirty_files="$(
	git -C "$server_root" status --porcelain --untracked-files=all
)"
if [[ -n "$dirty_files" ]]; then
	echo "Backend deployment checkout is not clean:" >&2
	echo "$dirty_files" >&2
	exit 1
fi

identity_automatic_prod_push="${IDENTITY_AUTOMATIC_PROD_PUSH:-${AUTOMATIC_PROD_PUSH:-false}}"
identity_database_phase="$(identity_database_current_phase)" || {
	echo 'Identity database lifecycle marker is invalid.' >&2
	exit 1
}
identity_routes_env_state="$(
	identity_env_node_validate "$ENV_FILE" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const read = key => {
  const matches = source.split(/\r?\n/).filter(line => line.startsWith(`${key}=`));
  if (matches.length !== 1) process.exit(1);
  const raw = matches[0].slice(key.length + 1).trim();
  if (!raw) process.exit(1);
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  return raw;
};
const routes = JSON.parse(read("GATEWAY_ROUTES_JSON"));
const jwksUrl = read("JWT_JWKS_URL");
const required = [
  ["identity-auth", "/api/v1/auth"],
  ["identity-users", "/api/v1/users"],
  ["identity-telegram-auth", "/api/v1/telegram-auth"],
  ["identity-info-webhook", "/api/v1/telegram-bot/webhook"],
];
if (!Array.isArray(routes)) process.exit(1);
const identity = required.every(([id, pathPrefix]) => routes.some(route =>
  route?.id === id && route.pathPrefix === pathPrefix &&
  route.upstreamUrl === "http://127.0.0.1:4900" &&
  route.authPolicy === "optional" && route.timeoutMs === 60000
)) && routes.filter(route => route?.upstreamUrl === "http://127.0.0.1:4900").length === 4 &&
  jwksUrl ===
    "http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json";
const legacy = required.every(([, pathPrefix]) =>
  !routes.some(route => route?.pathPrefix === pathPrefix)) &&
  !routes.some(route => route?.upstreamUrl === "http://127.0.0.1:4900") &&
  jwksUrl ===
    "http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json";
process.stdout.write(identity ? "identity" : legacy ? "legacy" : "unsafe");
NODE
)" || {
	echo 'Identity Gateway route/JWKS env contract is invalid.' >&2
	exit 1
}
case "$identity_database_phase:$identity_routes_env_state" in
absent:legacy | aborted:legacy)
	if [[ "$identity_automatic_prod_push" == 'true' ]]; then
		echo "Automatic backend revision $deploy_revision is verified but Identity first rollout is deferred."
		echo 'Run the manual Identity prepare action before the one-time ownership cutover.'
		exit 0
	fi
	echo 'Manual full deployment is blocked until Identity preparation and cutover complete.' >&2
	exit 1
	;;
complete:identity) ;;
prepared:legacy | preparing:* | forward-only:* | active:*)
	echo "Routine deployment is blocked during Identity cutover phase=$identity_database_phase." >&2
	exit 1
	;;
*)
	echo "Identity lifecycle/routes/JWKS are inconsistent: phase=$identity_database_phase routes=$identity_routes_env_state." >&2
	exit 1
	;;
esac
identity_runtime_services=(identity-api identity-worker identity-outbox-publisher)
support_runtime_services=(support-api support-worker support-outbox-publisher)

identity_cleanup_migration='20260815000000_remove_legacy_identity_core_source'
identity_cleanup_directory="$server_root/prisma/migrations/$identity_cleanup_migration"
identity_cleanup_migration_file="$identity_cleanup_directory/migration.sql"
identity_cleanup_marker="$APP_ROOT/deploy/backend/.identity-core-cleanup-v1"
identity_cleanup_phase='absent'
if [[ -e "$identity_cleanup_directory" || -L "$identity_cleanup_directory" ]]; then
	[[ -d "$identity_cleanup_directory" && ! -L "$identity_cleanup_directory" &&
		-f "$identity_cleanup_migration_file" && ! -L "$identity_cleanup_migration_file" ]] || {
		echo 'Identity Core cleanup migration path is unsafe.' >&2
		exit 1
	}
	if [[ ! -e "$identity_cleanup_marker" && ! -L "$identity_cleanup_marker" ]]; then
		if [[ "$identity_automatic_prod_push" == 'true' ]]; then
			echo "Automatic backend revision $deploy_revision is verified but the destructive Identity Core cleanup is deferred."
			echo 'Use the manual identity-cleanup target after its soak, backup and clean-restore gates pass.'
			exit 0
		fi
		echo 'Routine deployment is blocked for an unstaged Identity Core cleanup revision.' >&2
		echo 'Use the manual identity-cleanup target; routine migrate must not apply the destructive migration.' >&2
		exit 1
	fi
	APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$deploy_revision" \
		bash "$server_root/scripts/cleanup-identity-core-source-production.sh" --status >/dev/null || {
		echo 'Identity Core cleanup marker is invalid.' >&2
		exit 1
	}
	identity_cleanup_state="$(awk -F= '
	  $1 == "phase" { phase=substr($0, index($0, "=") + 1); phase_count += 1 }
	  $1 == "cleanup_revision" { revision=substr($0, index($0, "=") + 1); revision_count += 1 }
	  $1 == "migration_sha256" { migration_sha=substr($0, index($0, "=") + 1); migration_sha_count += 1 }
	  END {
	    if (phase_count != 1 || revision_count != 1 || migration_sha_count != 1 ||
	        phase !~ /^(verified|forward-only|complete)$/ ||
	        revision !~ /^[0-9a-f]{40}$/ || migration_sha !~ /^[0-9a-f]{64}$/) exit 1
	    printf "%s|%s|%s", phase, revision, migration_sha
	  }
	' "$identity_cleanup_marker")" || {
		echo 'Identity Core cleanup marker identity is unreadable.' >&2
		exit 1
	}
	identity_cleanup_phase="${identity_cleanup_state%%|*}"
	identity_cleanup_bound="${identity_cleanup_state#*|}"
	identity_cleanup_bound="${identity_cleanup_bound%%|*}"
	identity_cleanup_migration_sha="${identity_cleanup_state##*|}"
	identity_cleanup_actual_migration_sha="$(
		sha256sum "$identity_cleanup_migration_file" | awk 'NR == 1 { print $1 }'
	)"
	[[ "$identity_cleanup_actual_migration_sha" == "$identity_cleanup_migration_sha" ]] || {
		echo 'Identity Core cleanup migration differs from its reviewed marker SHA-256.' >&2
		exit 1
	}
	case "$identity_cleanup_phase" in
	verified | forward-only)
		if [[ "$identity_automatic_prod_push" == 'true' ]]; then
			echo "Automatic backend deployment is deferred while Identity Core cleanup is phase=$identity_cleanup_phase."
			exit 0
		fi
		echo "Routine deployment is blocked while Identity Core cleanup is phase=$identity_cleanup_phase." >&2
		echo 'Resume the exact manual identity-cleanup workflow.' >&2
		exit 1
		;;
	complete)
		[[ "$(identity_database_marker_value cleanup_revision)" == "$identity_cleanup_bound" ]] || {
			echo 'Identity database lifecycle is not bound to the completed cleanup revision.' >&2
			exit 1
		}
		git -C "$server_root" merge-base --is-ancestor \
			"$identity_cleanup_bound" "$deploy_revision" || {
			echo 'Routine deployment would downgrade past the completed Identity Core cleanup.' >&2
			exit 1
		}
		;;
	esac
fi

widgets_automatic_prod_push="${WIDGETS_AUTOMATIC_PROD_PUSH:-false}"
widgets_deploy_action="$(
	widgets_full_deploy_action "$widgets_automatic_prod_push"
)" || {
	echo 'Widgets ownership state is invalid; refusing full deployment.' >&2
	exit 1
}
case "$widgets_deploy_action" in
defer)
	echo "Automatic backend revision $deploy_revision is verified but deferred."
	echo 'Widgets ownership is not active; only the manual widgets target may perform the first cutover.'
	exit 0
	;;
block)
	echo 'Manual full deployment is blocked until the one-time Widgets cutover is complete.' >&2
	echo 'Run the manual widgets deployment target; routine all deployments cannot activate ownership.' >&2
	exit 1
	;;
deploy) ;;
*)
	echo 'Widgets full deployment action is invalid.' >&2
	exit 1
	;;
esac

billing_automatic_prod_push="${BILLING_AUTOMATIC_PROD_PUSH:-false}"
billing_database_phase="$(billing_database_current_phase)" || {
	echo 'Billing database lifecycle marker is invalid.' >&2
	exit 1
}
case "$billing_database_phase" in
absent)
	if [[ "$billing_automatic_prod_push" == 'true' ]]; then
		echo "Automatic backend revision $deploy_revision is verified but Billing first rollout is deferred."
		echo 'Run the manual Billing prepare action so source queues are ready before the guarded Core migration.'
		exit 0
	fi
	echo 'Manual full deployment is blocked before Billing first-rollout preparation.' >&2
	echo 'Use the Billing prepare action; routine migrate-before-recreate is unsafe for the new source events.' >&2
	exit 1
	;;
preparing | aborted)
	echo "Billing lifecycle is incomplete at phase=$billing_database_phase." >&2
	echo 'Resume the exact pinned Billing prepare/abort action before a routine deployment.' >&2
	exit 1
	;;
prepared | source-frozen | imported | pre-backups-created | \
	pre-restore-verified | projection-synced | forward-only | active | \
	post-backup-created | post-restore-verified | complete)
	billing_database_guard_revision "$deploy_revision" || exit 1
	# Defined by the sourced billing database lifecycle contract.
	# shellcheck disable=SC2154
	[[ -f "$billing_cutover_marker" && ! -L "$billing_cutover_marker" &&
		"$(stat -c '%u:%g:%a' "$billing_cutover_marker")" == '0:0:600' ]] || {
		echo 'Billing routine deployment requires the durable post-migration cutover marker.' >&2
		echo 'Resume the pinned Billing prepare action; do not run routine Core migrate.' >&2
		exit 1
	}
	billing_routine_marker_state="$(awk -F= '
		$1 == "version" { version=$2; version_count += 1 }
		$1 == "phase" { phase=$2; phase_count += 1 }
		$1 == "revision" { revision=$2; revision_count += 1 }
		$1 == "route_sha256" { route=$2; route_count += 1 }
		END {
			if (version_count != 1 || version != 2 || phase_count != 1 ||
				revision_count != 1 || route_count != 1) exit 1
			printf "%s|%s|%s", phase, revision, route
		}
	' "$billing_cutover_marker")" || {
		echo 'Billing cutover marker identity is unreadable.' >&2
		exit 1
	}
	[[ "$billing_routine_marker_state" == \
		"$billing_database_phase|$(billing_database_marker_value ownership_revision)|$(billing_database_marker_value route_evidence_sha256)" ]] || {
		echo 'Billing database/cutover marker phases or ownership revisions differ.' >&2
		exit 1
	}
	;;
*)
	echo "Billing lifecycle phase is unsafe: $billing_database_phase." >&2
	exit 1
	;;
esac
billing_routes_env_state="$(
	billing_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON | billing_release_node_stdin -e '
const fs = require("node:fs");
const routes = JSON.parse(fs.readFileSync(0, "utf8"));
const prefixes = [
  "/api/v1/payments",
  "/api/v1/subscriptions",
  "/api/v1/tariff-prices",
  "/api/v1/affiliate",
];
if (!Array.isArray(routes)) process.exit(1);
const billing = prefixes.every(prefix => routes.some(route =>
  route?.pathPrefix === prefix && route.upstreamUrl === "http://127.0.0.1:4800" &&
  route.authPolicy === "optional"
));
const legacy = prefixes.every(prefix => !routes.some(route => route?.pathPrefix === prefix)) &&
  routes.some(route => route?.pathPrefix === "/api/v1" &&
    route.upstreamUrl === "http://127.0.0.1:4200");
process.stdout.write(billing ? "billing" : legacy ? "legacy" : "unsafe");
'
)" || {
	echo 'Billing Gateway route env contract is invalid.' >&2
	exit 1
}
case "$billing_database_phase:$billing_routes_env_state" in
prepared:legacy | complete:billing) ;;
source-frozen:* | imported:* | pre-backups-created:* | \
	pre-restore-verified:* | projection-synced:* | forward-only:* | active:* | \
	post-backup-created:* | post-restore-verified:*)
	echo "Routine deployment is blocked during Billing cutover phase=$billing_database_phase." >&2
	exit 1
	;;
prepared:billing)
	echo 'Billing route env is staged; only the pinned cutover may restart Gateway.' >&2
	exit 1
	;;
*)
	echo "Billing lifecycle/routes are inconsistent: phase=$billing_database_phase routes=$billing_routes_env_state." >&2
	exit 1
	;;
esac
billing_runtime_services=(
	billing-api
	billing-worker
	billing-outbox-publisher
)
if [[ "$billing_database_phase" == 'active' ||
	"$billing_database_phase" == 'complete' ]]; then
	billing_runtime_services+=(billing-scheduler)
fi

billing_core_cleanup_require_bound_pre_evidence() {
	local revision generation directory key expected file
	billing_core_source_cleanup_validate_marker || return 1
	revision="$(billing_core_source_cleanup_marker_value revision)" || return 1
	generation="$(billing_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")" ||
		return 1
	for key in core_backup_sha256 billing_backup_sha256 restore_evidence_sha256 \
		queue_drain_evidence_sha256 stopped_writers_evidence_sha256 \
		pre_offsite_receipt_sha256; do
		expected="$(billing_core_source_cleanup_marker_value "$key")" || return 1
		[[ "$expected" =~ ^[0-9a-f]{64}$ && ! "$expected" =~ ^0+$ ]] || return 1
		file="$(billing_core_source_cleanup_evidence_file_for_key "$directory" "$key")" ||
			return 1
		billing_core_source_cleanup_validate_private_file "$file" "$expected" || return 1
	done
	[[ "$(billing_core_source_cleanup_marker_value retention_reference)" == \
		"$(billing_core_source_cleanup_marker_value pre_offsite_receipt_sha256)" &&
		"$(billing_core_source_cleanup_marker_value core_system_identifier)" =~ ^[1-9][0-9]*$ &&
		"$(billing_core_source_cleanup_marker_value billing_system_identifier)" =~ ^[1-9][0-9]*$ &&
		"$(billing_core_source_cleanup_marker_value billing_database_id)" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]
}

billing_core_cleanup_runtime_deploy=false
billing_core_cleanup_stop_recovery_active=false
billing_core_cleanup_marker_phase='absent'
billing_core_cleanup_source_state="$(billing_core_source_state)" || {
	echo 'Unable to read the legacy Billing Core source state.' >&2
	exit 1
}
billing_core_cleanup_migration_state="$(
	billing_core_source_cleanup_migration_state
)" || {
	echo 'Unable to read the Billing Core source cleanup migration state.' >&2
	exit 1
}
billing_core_cleanup_marker_file="$(billing_core_source_cleanup_marker_path)"
if [[ -e "$billing_core_cleanup_marker_file" ||
	-L "$billing_core_cleanup_marker_file" ]]; then
	billing_core_source_cleanup_validate_marker || {
		echo 'Billing Core source cleanup marker is present but invalid.' >&2
		exit 1
	}
	billing_core_cleanup_marker_phase="$(billing_core_source_cleanup_marker_value phase)"
	billing_core_cleanup_marker_revision="$(billing_core_source_cleanup_marker_value revision)"
	case "$billing_core_cleanup_marker_phase|$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" in
	staged\|present\|pending | staged\|present\|rolled-back | staged\|present\|unfinished | \
		staged\|absent\|unfinished | staged\|absent\|applied | \
		applied\|absent\|unfinished | applied\|absent\|applied)
		[[ "$billing_core_cleanup_marker_revision" == "$deploy_revision" ]] || {
			echo "Billing Core source cleanup is pinned to revision $billing_core_cleanup_marker_revision." >&2
			exit 1
		}
		billing_core_source_cleanup_require_evidence || {
			echo 'Billing Core source cleanup evidence is missing or changed.' >&2
			exit 1
		}
		if [[ "$billing_automatic_prod_push" == 'true' ]]; then
			echo "Automatic backend revision $deploy_revision is verified but the staged Billing Core source cleanup remains manual-only."
			exit 0
		fi
		[[ "${BILLING_CORE_SOURCE_CLEANUP_APPROVED:-false}" == 'true' &&
			"${BILLING_CORE_SOURCE_CLEANUP_CONFIRMATION:-}" == \
			'DROP LEGACY BILLING CORE SOURCE' ]] || {
			echo 'The staged Billing Core source cleanup requires the exact manual confirmation.' >&2
			exit 1
		}
		billing_core_cleanup_require_bound_pre_evidence || {
			echo 'Billing Core source cleanup pre-migration evidence is not fully sealed.' >&2
			exit 1
		}
		if [[ "$billing_core_cleanup_migration_state" == 'applied' ]]; then
			billing_core_source_cleanup_require_exact_migration_manifest applied
		else
			billing_core_source_cleanup_require_exact_migration_manifest exclusive
		fi || {
			echo 'Billing Core cleanup migration ledger does not match the exact reviewed migration tree.' >&2
			exit 1
		}
		billing_core_cleanup_runtime_deploy=true
		;;
	complete\|absent\|applied)
		billing_core_source_cleanup_require_evidence || {
			echo 'Completed Billing Core source cleanup evidence is missing or changed.' >&2
			exit 1
		}
		git -C "$server_root" merge-base --is-ancestor \
			"$billing_core_cleanup_marker_revision" "$deploy_revision" || {
			echo 'Routine deployment would downgrade past the completed Billing Core source cleanup.' >&2
			exit 1
		}
		;;
	*)
		echo "Billing Core source cleanup state is unsafe: marker=$billing_core_cleanup_marker_phase source=$billing_core_cleanup_source_state migration=$billing_core_cleanup_migration_state." >&2
		exit 1
		;;
	esac
else
	case "$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" in
	present\|pending | present\|rolled-back)
		if [[ "$deploy_revision" == "$(billing_database_marker_value ownership_revision)" ]]; then
			:
		elif [[ "$billing_automatic_prod_push" == 'true' ]]; then
			echo "Automatic backend revision $deploy_revision is verified but the destructive Billing Core source cleanup is deferred."
			echo 'Stage fresh Core and Billing backup/restore/offsite evidence before the exact manual cleanup.'
			exit 0
		else
			echo 'Manual full deployment is blocked until Billing Core source cleanup evidence is staged.' >&2
			exit 1
		fi
		;;
	*)
		echo "Billing Core source/cleanup state has no durable evidence marker: source=$billing_core_cleanup_source_state migration=$billing_core_cleanup_migration_state." >&2
		exit 1
		;;
	esac
fi

widgets_core_cleanup_runtime_deploy=false
widgets_core_cleanup_stop_recovery_active=false
widgets_core_cleanup_marker_phase='absent'
widgets_core_cleanup_source_state="$(widgets_core_source_state)" || {
	echo 'Unable to read the legacy Widgets Core source state.' >&2
	exit 1
}
widgets_core_cleanup_migration_state="$(
	widgets_core_source_cleanup_migration_state
)" || {
	echo 'Unable to read the Widgets Core source cleanup migration state.' >&2
	exit 1
}
widgets_core_cleanup_marker_file="$(widgets_core_source_cleanup_marker_path)"
if [[ -e "$widgets_core_cleanup_marker_file" ||
	-L "$widgets_core_cleanup_marker_file" ]]; then
	widgets_core_source_cleanup_validate_marker || {
		echo 'Widgets Core source cleanup marker is present but invalid.' >&2
		exit 1
	}
	widgets_core_cleanup_marker_phase="$(widgets_core_source_cleanup_marker_value phase)"
	widgets_core_cleanup_marker_revision="$(widgets_core_source_cleanup_marker_value revision)"
	case "$widgets_core_cleanup_marker_phase|$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" in
	staged\|present\|pending | staged\|present\|rolled-back | staged\|present\|unfinished | \
		staged\|absent\|unfinished | staged\|absent\|applied | \
		applied\|absent\|unfinished | applied\|absent\|applied)
		[[ "$widgets_core_cleanup_marker_revision" == "$deploy_revision" ]] || {
			echo "Widgets Core source cleanup is pinned to revision $widgets_core_cleanup_marker_revision." >&2
			exit 1
		}
		if [[ "$widgets_automatic_prod_push" == 'true' ]]; then
			echo "Automatic backend revision $deploy_revision is verified but the staged Widgets Core source cleanup remains manual-only."
			exit 0
		fi
		[[ "${WIDGETS_CORE_SOURCE_CLEANUP_APPROVED:-false}" == 'true' &&
			"${WIDGETS_CORE_SOURCE_CLEANUP_CONFIRMATION:-}" == \
			'DROP LEGACY WIDGETS CORE SOURCE' ]] || {
			echo 'The staged Widgets Core source cleanup requires the exact manual confirmation.' >&2
			exit 1
		}
		widgets_core_cleanup_runtime_deploy=true
		;;
	complete\|absent\|applied)
		widgets_core_source_cleanup_require_completion_evidence || {
			echo 'Completed Widgets Core source cleanup evidence is missing or changed.' >&2
			exit 1
		}
		widgets_core_source_cleanup_local_retention_is_finalized || {
			echo 'Completed Widgets Core source cleanup raw VPS evidence is not finalized.' >&2
			exit 1
		}
		git -C "$server_root" merge-base --is-ancestor \
			"$widgets_core_cleanup_marker_revision" "$deploy_revision" || {
			echo 'Routine deployment would downgrade past the completed Widgets Core source cleanup.' >&2
			exit 1
		}
		;;
	*)
		echo "Widgets Core source cleanup state is unsafe: marker=$widgets_core_cleanup_marker_phase source=$widgets_core_cleanup_source_state migration=$widgets_core_cleanup_migration_state." >&2
		exit 1
		;;
	esac
else
	case "$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" in
	present\|pending | present\|rolled-back)
		if [[ "$widgets_automatic_prod_push" == 'true' ]]; then
			echo "Automatic backend revision $deploy_revision is verified but the destructive Widgets Core source cleanup is deferred."
			echo 'Stage fresh Core and Widgets backup/restore evidence before the exact manual cleanup.'
			exit 0
		fi
		echo 'Manual full deployment is blocked until Widgets Core source cleanup evidence is staged.' >&2
		exit 1
		;;
	*)
		echo "Widgets Core source/cleanup state has no durable evidence marker: source=$widgets_core_cleanup_source_state migration=$widgets_core_cleanup_migration_state." >&2
		exit 1
		;;
	esac
fi

expected_integration_worker_kinds="$(
	reporting_expected_integration_worker_kinds
)" || {
	echo 'Unable to resolve the integration-worker ownership contract.' >&2
	exit 1
}
[[ -n "$expected_integration_worker_kinds" ]] || {
	echo 'The integration-worker ownership contract is empty.' >&2
	exit 1
}
expected_integration_worker_kinds="$IDENTITY_STEADY_INTEGRATION_WORKER_KINDS"

# database-restore-production-guard: before-mutation
database_restore_guard_assert_before_mutation \
	identity-if-present "$ENV_FILE"
reporting_transition_cleanup_integration_worker_env "$deploy_revision"

reporting_automatic_prod_push="${REPORTING_AUTOMATIC_PROD_PUSH:-false}"
reporting_deploy_action="$(
	reporting_first_rollout_deploy_action \
		"$reporting_automatic_prod_push" \
		"$deploy_revision"
)" || {
	echo "Reporting first-rollout marker state is invalid." >&2
	exit 1
}
case "$reporting_deploy_action" in
	stage)
		reporting_write_first_rollout_staged_marker "$deploy_revision"
		echo "Reporting first-rollout revision $deploy_revision is staged on the VPS."
		echo "Restore safety state was verified; no Compose configuration was evaluated, image built, runtime changed or database accessed."
		echo "Run the manual reporting-database prepare workflow next."
		exit 0
		;;
	prepare)
		echo "Manual full deployment is blocked until the staged Reporting database is prepared." >&2
		echo "Run the reporting-database prepare workflow for revision $deploy_revision." >&2
		exit 1
		;;
	block)
		echo "Reporting database preparation is incomplete at revision $deploy_revision." >&2
		echo "Resume the pinned reporting-database prepare workflow before any deployment." >&2
		exit 1
		;;
	deploy) ;;
	*)
		echo "Reporting first-rollout action is invalid." >&2
		exit 1
		;;
esac
reporting_scheduler_policy="$(reporting_cutover_runtime_scheduler_policy)" || {
	echo 'Reporting cutover scheduler policy is invalid.' >&2
	exit 1
}
reporting_gateway_policy="$(reporting_cutover_runtime_gateway_policy)" || {
	echo 'Reporting cutover Gateway policy is invalid.' >&2
	exit 1
}
# Defaults are owned by the sourced lifecycle; keep them explicit here so
# static analysis can follow their later use through the dynamic source path.
notification_database_cutover_active=false
notification_database_phase_before=""
# shellcheck source=scripts/notification-delivery-database-lifecycle.sh
source "$server_root/scripts/notification-delivery-database-lifecycle.sh"
# shellcheck source=scripts/campaigns-database-lifecycle.sh
source "$server_root/scripts/campaigns-database-lifecycle.sh"

campaigns_automatic_prod_push="${CAMPAIGNS_AUTOMATIC_PROD_PUSH:-false}"
campaigns_cutover_phase="missing"
if [[ -e "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ||
	-L "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ]]; then
	if ! validate_campaigns_database_cutover_marker; then
		echo "Campaigns database cutover marker is invalid; refusing full deployment." >&2
		exit 1
	fi
	campaigns_cutover_phase="$(campaigns_database_marker_value phase)"
fi
campaigns_deploy_action="$(
	campaigns_full_deploy_action \
		"$campaigns_automatic_prod_push" \
		"$campaigns_cutover_phase"
)" || {
	echo "Campaigns full deployment trigger or cutover phase is invalid." >&2
	exit 1
}
case "$campaigns_deploy_action" in
	stage)
		guard_campaigns_cutover_checkout_revision "$deploy_revision"
		write_campaigns_first_cutover_staged_marker "$deploy_revision"
		echo "Campaigns first-cutover revision $deploy_revision is staged on the VPS."
		echo "No image was built, container restarted or migration applied."
		echo "The completed Campaigns database action is retired; follow the production recovery runbook before continuing."
		exit 0
		;;
	block)
		if [[ "$campaigns_cutover_phase" == "missing" ]]; then
			echo "Manual full deployment is blocked before the Campaigns cutover is complete." >&2
			echo "Recover the completed Campaigns lifecycle marker from reviewed production evidence before continuing." >&2
		else
			echo "Campaigns database cutover is in phase $campaigns_cutover_phase." >&2
		fi
		echo "Production pushes must remain frozen until phase=complete; changing revision requires reviewed cutover recovery." >&2
		exit 1
		;;
	deploy) ;;
	*)
		echo "Campaigns full deployment action is invalid." >&2
		exit 1
		;;
esac

export APP_REVISION="$deploy_revision"
export APP_VERSION="git-$deploy_revision"
export MAINTENANCE_REVISION="$deploy_revision"
export MAINTENANCE_IMAGE="winwidget-maintenance:git-$deploy_revision"
export DATABASE_RESTORE_REVISION="$deploy_revision"
export DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$deploy_revision"
export NOTIFICATION_DELIVERY_REVISION="$deploy_revision"
export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$deploy_revision"
export CAMPAIGNS_REVISION="$deploy_revision"
export CAMPAIGNS_IMAGE="winwidget-campaigns:git-$deploy_revision"
export REPORTING_REVISION="$deploy_revision"
export REPORTING_IMAGE="winwidget-reporting:git-$deploy_revision"
export WIDGETS_REVISION="$deploy_revision"
export WIDGETS_IMAGE="winwidget-widgets:git-$deploy_revision"
export BILLING_REVISION="$deploy_revision"
export BILLING_IMAGE="winwidget-billing:git-$deploy_revision"
export IDENTITY_REVISION="$deploy_revision"
export IDENTITY_IMAGE="winwidget-identity:git-$deploy_revision"
export SUPPORT_REVISION="$deploy_revision"
export SUPPORT_IMAGE="winwidget-support:git-$deploy_revision"

echo "Deploying backend revision: $APP_REVISION"
echo "Building backend image: winwidget-api:$APP_VERSION"
echo "Building gateway image: winwidget-api-gateway:$APP_VERSION"
echo "Building maintenance image: $MAINTENANCE_IMAGE"
echo "Building isolated database restore image: $DATABASE_RESTORE_IMAGE"
echo "Building Widgets image: $WIDGETS_IMAGE"
echo "Building notification delivery image: $NOTIFICATION_DELIVERY_IMAGE"
echo "Building Campaigns image: $CAMPAIGNS_IMAGE"
echo "Building Support image: $SUPPORT_IMAGE"
echo "Building Reporting image for the coordinated backend revision: $REPORTING_IMAGE"
echo "Building Billing image for the coordinated backend revision: $BILLING_IMAGE"
echo "Building Identity image for the coordinated backend revision: $IDENTITY_IMAGE"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Backend env file not found: $ENV_FILE" >&2
	exit 1
fi

env_mode="$(stat -c '%a' "$ENV_FILE")"
env_group_digit="${env_mode: -2:1}"
env_other_digit="${env_mode: -1}"
if ((10#$env_group_digit != 0 || 10#$env_other_digit != 0)); then
	echo "Backend env file must not be accessible by group or others: $ENV_FILE (mode $env_mode)" >&2
	echo "Run: chmod 600 $ENV_FILE" >&2
	exit 1
fi

duplicate_env_keys="$(
	awk '
		/^[[:space:]]*(#|$)/ { next }
		{
			line = $0
			sub(/^[[:space:]]*/, "", line)
			if (line !~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next

			name = line
			sub(/[[:space:]]*=.*/, "", name)
			count[name] += 1
		}
		END {
			for (name in count) {
				if (count[name] > 1) print name
			}
		}
	' "$ENV_FILE" | LC_ALL=C sort
)"
if [[ -n "$duplicate_env_keys" ]]; then
	echo "Duplicate environment keys are not allowed in $ENV_FILE:" >&2
	echo "$duplicate_env_keys" >&2
	exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "Backend Compose file not found: $COMPOSE_FILE" >&2
	exit 1
fi

ambient_compose_overrides=()
while IFS= read -r key; do
	[[ -n "$key" ]] || continue
	case "$key" in
	APP_REVISION | APP_VERSION | MAINTENANCE_IMAGE | MAINTENANCE_REVISION | DATABASE_RESTORE_IMAGE | DATABASE_RESTORE_REVISION | NOTIFICATION_DELIVERY_IMAGE | NOTIFICATION_DELIVERY_REVISION | CAMPAIGNS_IMAGE | CAMPAIGNS_REVISION | REPORTING_IMAGE | REPORTING_REVISION | WIDGETS_IMAGE | WIDGETS_REVISION | BILLING_IMAGE | BILLING_REVISION | IDENTITY_IMAGE | IDENTITY_REVISION)
			continue
			;;
	esac
	if printenv "$key" >/dev/null 2>&1; then
		ambient_compose_overrides+=("$key")
	fi
done < <(
	LC_ALL=C grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" |
		sed 's/^${//' |
		LC_ALL=C sort -u
)
if ((${#ambient_compose_overrides[@]} > 0)); then
	echo "Unset shell variables that would override $ENV_FILE in Docker Compose:" >&2
	printf '%s\n' "${ambient_compose_overrides[@]}" >&2
	exit 1
fi

require_env_key() {
	local key="$1"

	if ! awk -F= -v key="$key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)

			value = $0
			sub(/^[^=]*=/, "", value)
			sub(/\r$/, "", value)
			sub(/^[[:space:]]*/, "", value)
			sub(/[[:space:]]*$/, "", value)

			if (name == key && value != "" && value !~ /^change_me/) ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "Missing required $key in $ENV_FILE" >&2
		exit 1
	fi
}

get_env_value() {
	local key="$1"

	awk -F= -v key="$key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)

			value = $0
			sub(/^[^=]*=/, "", value)
			sub(/\r$/, "", value)
			sub(/^[[:space:]]*/, "", value)
			sub(/[[:space:]]*$/, "", value)

			if (name == key) {
				print value
				found = 1
				exit
			}
		}
		END { exit(found ? 0 : 1) }
	' "$ENV_FILE"
}

validate_ipv4_address() {
	local value="$1"
	local octet
	local -a octets=()

	[[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
	IFS='.' read -r -a octets <<<"$value"
	[[ "${#octets[@]}" == '4' ]] || return 1
	for octet in "${octets[@]}"; do
		[[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
		((10#$octet <= 255)) || return 1
	done
}

verify_telegram_https_reverse_proxy() {
	local proxy_ip="$1"
	local header_file http_status marker

	header_file="$(mktemp)" || return 1
	if ! http_status="$(
		curl --noproxy '*' --silent --show-error \
			--connect-timeout 5 --max-time 15 \
			--resolve "tg.winwidget.ru:443:$proxy_ip" \
			--dump-header "$header_file" \
			--output /dev/null --write-out '%{http_code}' \
			https://tg.winwidget.ru/telegram-api-health
	)"; then
		rm -f -- "$header_file"
		return 1
	fi
	marker="$(awk '
		tolower($1) == "x-winwidget-telegram-proxy:" {
			gsub(/\r/, "", $2)
			value = $2
		}
		END { if (value == "active") print value; else exit 1 }
	' "$header_file")" || {
		rm -f -- "$header_file"
		return 1
	}
	rm -f -- "$header_file"
	[[ "$http_status" =~ ^[234][0-9]{2}$ && "$marker" == 'active' ]]
}

get_database_username() {
	local key="$1"
	local value

	value="$(get_env_value "$key")"
	if [[ "$value" =~ ^postgres(ql)?://([A-Za-z0-9._-]+):[^@]+@ ]]; then
		printf '%s' "${BASH_REMATCH[2]}"
		return
	fi
	echo "$key must be a PostgreSQL URL with an explicit non-encoded username and password" >&2
	exit 1
}

assert_distinct_database_roles() {
	local -a role_keys=(
		DATABASE_URL_PRODUCTION
		DATABASE_MIGRATION_URL_PRODUCTION
		MAINTENANCE_DATABASE_URL_PRODUCTION
		NOTIFICATION_DELIVERY_DATABASE_URL
		NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
		NOTIFICATION_DELIVERY_BACKUP_URL
		CAMPAIGNS_DATABASE_URL
		CAMPAIGNS_MIGRATION_DATABASE_URL
		CAMPAIGNS_BACKUP_URL
		REPORTING_DATABASE_URL
		REPORTING_MIGRATION_DATABASE_URL
		REPORTING_BACKUP_URL
		WIDGETS_DATABASE_URL
		WIDGETS_MIGRATION_DATABASE_URL
		WIDGETS_BACKUP_URL
		BILLING_DATABASE_URL
		BILLING_MIGRATION_DATABASE_URL
		BILLING_BACKUP_URL
		IDENTITY_DATABASE_URL
		IDENTITY_MIGRATION_DATABASE_URL
		IDENTITY_BACKUP_URL
		PLATFORM_DATABASE_URL
		PLATFORM_MIGRATION_DATABASE_URL
		PLATFORM_BACKUP_URL
		SUPPORT_DATABASE_URL
		SUPPORT_MIGRATION_DATABASE_URL
		SUPPORT_BACKUP_URL
	)
	local -a role_users=()
	local key
	local left
	local right

	for key in "${role_keys[@]}"; do
		role_users+=("$(get_database_username "$key")")
	done
	for ((left = 0; left < ${#role_users[@]}; left++)); do
		for ((right = left + 1; right < ${#role_users[@]}; right++)); do
			if [[ "${role_users[$left]}" == "${role_users[$right]}" ]]; then
				echo "Core runtime/migration/maintenance and eight service-owned database contours must use twenty-seven distinct PostgreSQL roles." >&2
				exit 1
			fi
		done
	done
}

require_env_exact_list() {
	local key="$1"
	local expected="$2"
	local value
	local normalized
	local normalized_expected
	if [[ -z "$expected" ]]; then
		echo "Required list contract could not be resolved for $key." >&2
		exit 1
	fi

	value="$(get_env_value "$key" || true)"
	normalized="$(
		tr ',' '\n' <<<"$value" |
			sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
			sed '/^$/d' |
			sort -u |
			paste -sd, -
	)"
	normalized_expected="$(
		tr ',' '\n' <<<"$expected" |
			sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
			sed '/^$/d' |
			sort -u |
			paste -sd, -
	)"
	if [[ "$normalized" != "$normalized_expected" ]]; then
		echo "$key in $ENV_FILE must contain exactly: $expected" >&2
		exit 1
	fi
}

require_env_base64url_secret() {
	local key="$1"
	local minimum_length="$2"
	local maximum_length="$3"

	if ! awk -v key="$key" -v minimum="$minimum_length" \
		-v maximum="$maximum_length" '
		/^[[:space:]]*(#|$)/ { next }
		{
			prefix = key "="
			if (index($0, prefix) != 1) next
			value = substr($0, length(prefix) + 1)
			if (value ~ /^[A-Za-z0-9_-]+$/ &&
				length(value) >= minimum && length(value) <= maximum) ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "$key must be an unquoted base64url secret between $minimum_length and $maximum_length characters with no surrounding whitespace" >&2
		exit 1
	fi
}

assert_database_restore_admin_secret_file() {
	local key="$1"
	local expected_path="$2"
	local secret_path
	local secret_identity
	local secret_size

	secret_path="$(get_env_value "$key")"
	if [[ "$secret_path" != "$expected_path" ||
		! -f "$secret_path" || -L "$secret_path" ]]; then
		echo "$key must reference its canonical regular production secret file." >&2
		exit 1
	fi
	secret_identity="$(stat -c '%a|%U:%G' "$secret_path")"
	secret_size="$(stat -c '%s' "$secret_path")"
	if [[ "$secret_identity" != '600|root:root' ||
		! "$secret_size" =~ ^[0-9]+$ ]] ||
		((secret_size < 16 || secret_size > 4096)); then
		echo "$key must be a root-owned mode-600 secret between 16 and 4096 bytes." >&2
		exit 1
	fi
}

prepare_database_restore_storage() {
	local storage_path
	local active_entry
	local directory

	storage_path="$(get_env_value DATABASE_RESTORE_STORAGE_DIR)"
	if [[ "$storage_path" != "$APP_ROOT/deploy/backend/database-restores" ]]; then
		echo 'DATABASE_RESTORE_STORAGE_DIR must use the canonical scoped production path.' >&2
		exit 1
	fi
	if [[ -e "$storage_path" || -L "$storage_path" ]]; then
		if [[ ! -d "$storage_path" || -L "$storage_path" ||
			"$(stat -c '%u:%g:%a' "$storage_path")" != '1001:1001:700' ]]; then
			echo 'Database restore storage must be a UID/GID 1001 private directory with mode 700.' >&2
			exit 1
		fi
	else
		install -d -m 700 -o 1001 -g 1001 "$storage_path"
	fi

	for directory in queued processing locks gates fences; do
		if [[ ! -e "$storage_path/$directory" &&
			! -L "$storage_path/$directory" ]]; then
			continue
		fi
		if [[ ! -d "$storage_path/$directory" ||
			-L "$storage_path/$directory" ||
			"$(stat -c '%u:%g:%a' "$storage_path/$directory")" != '1001:1001:700' ]]; then
			echo "Unsafe database restore queue directory: $directory" >&2
			exit 1
		fi
		active_entry="$(
			find "$storage_path/$directory" -mindepth 1 -maxdepth 1 \
				-print -quit 2>/dev/null || true
		)"
		if [[ -n "$active_entry" ]]; then
			echo "Deployment is blocked by active or fenced database restore state in $directory." >&2
			exit 1
		fi
	done
}

mode="$(get_env_value "MODE" || true)"
mode="${mode:-production}"
mode="${mode,,}"
telegram_api_proxy_ip=""

for key in \
	JWT_ISSUER \
	JWT_AUDIENCE \
	JWT_ACCESS_TTL_SECONDS \
	JWT_CLOCK_TOLERANCE_SECONDS \
	GATEWAY_LISTEN_HOST \
	GATEWAY_PORT \
	GATEWAY_ROUTES_JSON \
	CORS_ALLOWED_ORIGINS \
	JWT_JWKS_URL \
	GATEWAY_SHUTDOWN_GRACE_MS; do
	require_env_key "$key"
done

if [[ "$identity_cleanup_phase" == 'complete' ]]; then
	for removed_identity_core_key in \
		JWT_ACCESS_PRIVATE_KEY_BASE64 \
		JWT_ACCESS_JWKS_BASE64 \
		JWT_ACCESS_ACTIVE_KID; do
		if awk -F= -v key="$removed_identity_core_key" '
			/^[[:space:]]*(#|$)/ { next }
			{
				name = $1
				sub(/^[[:space:]]*/, "", name)
				sub(/[[:space:]]*$/, "", name)
				if (name == key) found = 1
			}
			END { exit(found ? 0 : 1) }
		' "$ENV_FILE"; then
			echo "$removed_identity_core_key must stay absent after completed Identity Core cleanup." >&2
			exit 1
		fi
	done
else
	for legacy_identity_core_key in \
		JWT_ACCESS_PRIVATE_KEY_BASE64 \
		JWT_ACCESS_JWKS_BASE64 \
		JWT_ACCESS_ACTIVE_KID; do
		require_env_key "$legacy_identity_core_key"
	done
fi

for legacy_key in \
	JWT_SECRET \
	API_UPSTREAM_URL \
	GATEWAY_PROXY_TIMEOUT_MS \
	RABBITMQ_LEGACY_USER \
	RABBITMQ_USER \
	RABBITMQ_PASSWORD \
	RABBITMQ_URL; do
	if awk -F= -v key="$legacy_key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)
			if (name == key) found = 1
		}
		END { exit(found ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "$legacy_key must be removed from $ENV_FILE" >&2
		exit 1
	fi
done

case "$mode" in
	production)
		require_env_key "DATABASE_URL_PRODUCTION"
		require_env_key "DATABASE_MIGRATION_URL_PRODUCTION"
		require_env_key "MAINTENANCE_DATABASE_URL_PRODUCTION"
		require_env_key "NOTIFICATION_DELIVERY_DATABASE_URL"
		require_env_key "NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION"
		require_env_key "NOTIFICATION_DELIVERY_BACKUP_URL"
		require_env_key "CAMPAIGNS_DATABASE_URL"
		require_env_key "CAMPAIGNS_MIGRATION_DATABASE_URL"
		require_env_key "CAMPAIGNS_BACKUP_URL"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_IMAGE"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_PORT"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "CAMPAIGNS_POSTGRES_IMAGE"
		require_env_key "CAMPAIGNS_POSTGRES_PORT"
		require_env_key "CAMPAIGNS_POSTGRES_DATA_VOLUME"
		require_env_key "CAMPAIGNS_POSTGRES_ADMIN_USER"
		require_env_key "CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "REPORTING_DATABASE_URL"
		require_env_key "REPORTING_MIGRATION_DATABASE_URL"
		require_env_key "REPORTING_BACKUP_URL"
		require_env_key "REPORTING_POSTGRES_IMAGE"
		require_env_key "REPORTING_POSTGRES_PORT"
		require_env_key "REPORTING_POSTGRES_DATA_VOLUME"
		require_env_key "REPORTING_POSTGRES_ADMIN_USER"
		require_env_key "REPORTING_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "WIDGETS_DATABASE_URL"
		require_env_key "WIDGETS_MIGRATION_DATABASE_URL"
		require_env_key "WIDGETS_BACKUP_URL"
		require_env_key "WIDGETS_POSTGRES_IMAGE"
		require_env_key "WIDGETS_POSTGRES_PORT"
		require_env_key "WIDGETS_POSTGRES_DATA_VOLUME"
		require_env_key "WIDGETS_POSTGRES_ADMIN_USER"
		require_env_key "WIDGETS_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "BILLING_DATABASE_URL"
		require_env_key "BILLING_MIGRATION_DATABASE_URL"
		require_env_key "BILLING_BACKUP_URL"
		require_env_key "BILLING_POSTGRES_IMAGE"
		require_env_key "BILLING_POSTGRES_PORT"
		require_env_key "BILLING_POSTGRES_DATA_VOLUME"
		require_env_key "BILLING_POSTGRES_ADMIN_USER"
		require_env_key "BILLING_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "IDENTITY_DATABASE_URL"
		require_env_key "IDENTITY_MIGRATION_DATABASE_URL"
		require_env_key "IDENTITY_BACKUP_URL"
		require_env_key "IDENTITY_POSTGRES_IMAGE"
		require_env_key "IDENTITY_POSTGRES_PORT"
		require_env_key "IDENTITY_POSTGRES_DATA_VOLUME"
		require_env_key "IDENTITY_POSTGRES_ADMIN_USER"
		require_env_key "IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "IDENTITY_AVATAR_S3_ENDPOINT"
		require_env_key "IDENTITY_AVATAR_S3_REGION"
		require_env_key "IDENTITY_AVATAR_S3_BUCKET"
		require_env_key "IDENTITY_AVATAR_S3_ACCESS_KEY_ID"
		require_env_key "IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY"
		require_env_key "IDENTITY_AVATAR_S3_PUBLIC_BASE_URL"
		require_env_key "IDENTITY_AVATAR_S3_FORCE_PATH_STYLE"
		require_env_key "PLATFORM_DATABASE_URL"
		require_env_key "PLATFORM_MIGRATION_DATABASE_URL"
		require_env_key "PLATFORM_BACKUP_URL"
		require_env_key "PLATFORM_POSTGRES_IMAGE"
		require_env_key "PLATFORM_POSTGRES_PORT"
		require_env_key "PLATFORM_POSTGRES_DATA_VOLUME"
		require_env_key "PLATFORM_POSTGRES_ADMIN_USER"
		require_env_key "PLATFORM_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "SUPPORT_DATABASE_URL"
		require_env_key "SUPPORT_MIGRATION_DATABASE_URL"
		require_env_key "SUPPORT_BACKUP_URL"
		require_env_key "SUPPORT_POSTGRES_IMAGE"
		require_env_key "SUPPORT_POSTGRES_PORT"
		require_env_key "SUPPORT_POSTGRES_DATA_VOLUME"
		require_env_key "SUPPORT_POSTGRES_ADMIN_USER"
		require_env_key "SUPPORT_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "CORE_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "DATABASE_RESTORE_STORAGE_DIR"
		require_env_key "DATABASE_RESTORE_QUEUE_SECRET"
		require_env_key "DATABASE_RESTORE_PRODUCTION_ENABLED"
		require_env_key "DATABASE_RESTORE_POLL_INTERVAL_MS"
		require_env_key "DATABASE_RESTORE_COMMAND_TIMEOUT_MS"
		require_env_key "PRODUCTION_HOST"
		require_env_key "AUTH_COOKIE_DOMAIN"
		require_env_key "COMPOSE_PROJECT_NAME"
		require_env_key "RABBITMQ_DATA_VOLUME"
		require_env_key "RABBITMQ_ADMIN_USER"
		require_env_key "RABBITMQ_ADMIN_PASSWORD"
		require_env_key "RABBITMQ_MONITOR_USER"
		require_env_key "RABBITMQ_MONITOR_PASSWORD"
		require_env_key "RABBITMQ_PUBLISHER_URL"
		require_env_key "RABBITMQ_INTEGRATION_WORKER_URL"
		require_env_key "RABBITMQ_MAINTENANCE_WORKER_URL"
		require_env_key "RABBITMQ_NOTIFICATION_DELIVERY_URL"
		require_env_key "RABBITMQ_CAMPAIGNS_URL"
		require_env_key "RABBITMQ_REPORTING_URL"
		require_env_key "RABBITMQ_WIDGETS_URL"
		require_env_key "RABBITMQ_BILLING_WORKER_URL"
		require_env_key "RABBITMQ_BILLING_PUBLISHER_URL"
		require_env_key "RABBITMQ_IDENTITY_WORKER_URL"
		require_env_key "RABBITMQ_IDENTITY_PUBLISHER_URL"
		require_env_key "RABBITMQ_PLATFORM_PUBLISHER_URL"
		require_env_key "RABBITMQ_SUPPORT_WORKER_URL"
		require_env_key "RABBITMQ_SUPPORT_PUBLISHER_URL"
		require_env_key "SMTP_SERVER"
		require_env_key "SMTP_LOGIN"
		require_env_key "SMTP_PASSWORD"
		require_env_key "SMTP_CONNECTION_TIMEOUT_MS"
		require_env_key "SMTP_GREETING_TIMEOUT_MS"
		require_env_key "SMTP_SOCKET_TIMEOUT_MS"
		require_env_key "TELEGRAM_INFO_BOT_TOKEN"
		require_env_key "TELEGRAM_SUPPORT_BOT_TOKEN"
		require_env_key "TELEGRAM_SUPPORT_BOT_USERNAME"
		require_env_key "TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET"
		require_env_key "TELEGRAM_API_BASE_URL"
		require_env_key "TELEGRAM_API_PROXY_IP"
		require_env_key "NOTIFICATION_DELIVERY_INTERNAL_URL"
		require_env_key "NOTIFICATION_DELIVERY_INTERNAL_TOKEN"
		require_env_key "NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS"
		require_env_key "CAMPAIGNS_INTERNAL_TOKEN"
		require_env_key "CAMPAIGNS_INTERNAL_TIMEOUT_MS"
		require_env_key "CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE"
		require_env_key "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS"
		require_env_key "CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE"
		require_env_key "CAMPAIGNS_PROCESS_ROLE"
		require_env_key "CAMPAIGNS_LISTEN_HOST"
		require_env_key "CAMPAIGNS_HEALTH_PORT"
		require_env_key "CAMPAIGNS_CORE_INTERNAL_BASE_URL"
		require_env_key "CAMPAIGNS_PREFETCH"
		require_env_key "CAMPAIGNS_EMAIL_RATE_PER_SECOND"
		require_env_key "CAMPAIGNS_TELEGRAM_RATE_PER_SECOND"
		require_env_key "CAMPAIGNS_OUTBOX_BATCH_SIZE"
		require_env_key "CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "CAMPAIGNS_OUTBOX_RETENTION_DAYS"
		require_env_key "REPORTING_INTERNAL_TOKEN"
		require_env_key "REPORTING_INTERNAL_TIMEOUT_MS"
		require_env_key "REPORTING_PROCESS_ROLE"
		require_env_key "REPORTING_LISTEN_HOST"
		require_env_key "REPORTING_PORT"
		require_env_key "REPORTING_CORE_INTERNAL_BASE_URL"
		require_env_key "REPORTING_SCHEDULER_ENABLED"
		require_env_key "REPORTING_PREFETCH"
		require_env_key "REPORTING_OUTBOX_BATCH_SIZE"
		require_env_key "REPORTING_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "REPORTING_OUTBOX_RETENTION_DAYS"
		require_env_key "WIDGETS_INTERNAL_TOKEN"
		require_env_key "WIDGETS_IDENTITY_TOKEN"
		require_env_key "WIDGETS_INTERNAL_TIMEOUT_MS"
		require_env_key "WIDGETS_ENTITLEMENT_MAX_STALENESS_MS"
		require_env_key "WIDGETS_PROCESS_ROLE"
		require_env_key "WIDGETS_LISTEN_HOST"
		require_env_key "WIDGETS_PORT"
		require_env_key "WIDGETS_CORE_INTERNAL_BASE_URL"
		require_env_key "WIDGETS_INTERNAL_BASE_URL"
		require_env_key "WIDGETS_PREFETCH"
		require_env_key "WIDGETS_OUTBOX_BATCH_SIZE"
		require_env_key "WIDGETS_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "WIDGETS_OUTBOX_RETENTION_DAYS"
		require_env_key "WIDGETS_RECEIPT_RETENTION_DAYS"
		require_env_key "WIDGETS_FAILURE_DETAIL_RETENTION_DAYS"
		require_env_key "BILLING_INTERNAL_BASE_URL"
		require_env_key "BILLING_CORE_INTERNAL_BASE_URL"
		require_env_key "BILLING_INTERNAL_TOKEN"
		require_env_key "BILLING_INTERNAL_TIMEOUT_MS"
		require_env_key "BILLING_LISTEN_HOST"
		require_env_key "BILLING_API_PORT"
		require_env_key "BILLING_SCHEDULER_PORT"
		require_env_key "BILLING_WORKER_PORT"
		require_env_key "BILLING_OUTBOX_PUBLISHER_PORT"
		require_env_key "BILLING_PREFETCH"
		require_env_key "BILLING_OUTBOX_BATCH_SIZE"
		require_env_key "BILLING_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "BILLING_OUTBOX_RETENTION_DAYS"
		require_env_key "BILLING_RECEIPT_RETENTION_DAYS"
		require_env_key "BILLING_FAILURE_DETAIL_RETENTION_DAYS"
		require_env_key "BILLING_CAMPAIGNS_TOKEN"
		require_env_key "BILLING_IDENTITY_TOKEN"
		require_env_key "IDENTITY_INTERNAL_BASE_URL"
		require_env_key "IDENTITY_INTERNAL_TIMEOUT_MS"
		require_env_key "IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64"
		require_env_key "IDENTITY_JWT_ACCESS_JWKS_BASE64"
		require_env_key "IDENTITY_JWT_ACCESS_ACTIVE_KID"
		require_env_key "IDENTITY_CORE_TOKEN"
		require_env_key "CORE_IDENTITY_TOKEN"
		require_env_key "IDENTITY_CAMPAIGNS_TOKEN"
		require_env_key "IDENTITY_REPORTING_TOKEN"
		require_env_key "IDENTITY_WIDGETS_TOKEN"
		require_env_key "IDENTITY_BILLING_TOKEN"
		require_env_key "IDENTITY_PLATFORM_TOKEN"
		require_env_key "IDENTITY_SUPPORT_TOKEN"
		require_env_key "IDENTITY_LISTEN_HOST"
		require_env_key "IDENTITY_API_PORT"
		require_env_key "IDENTITY_WORKER_PORT"
		require_env_key "IDENTITY_OUTBOX_PUBLISHER_PORT"
		require_env_key "IDENTITY_PREFETCH"
		require_env_key "IDENTITY_OUTBOX_BATCH_SIZE"
		require_env_key "IDENTITY_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "IDENTITY_OUTBOX_RETENTION_DAYS"
		require_env_key "IDENTITY_RECEIPT_RETENTION_DAYS"
		require_env_key "IDENTITY_FAILURE_DETAIL_RETENTION_DAYS"
		require_env_key "IDENTITY_CORE_CLEANUP_SOAK_SECONDS"
		require_env_key "PLATFORM_LISTEN_HOST"
		require_env_key "PLATFORM_API_PORT"
		require_env_key "PLATFORM_OUTBOX_PUBLISHER_PORT"
		require_env_key "PLATFORM_INTERNAL_BASE_URL"
		require_env_key "PLATFORM_CORE_TOKEN"
		require_env_key "PLATFORM_INTERNAL_TIMEOUT_MS"
		require_env_key "PLATFORM_OUTBOX_BATCH_SIZE"
		require_env_key "PLATFORM_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "PLATFORM_OUTBOX_RETENTION_DAYS"
		require_env_key "PLATFORM_RESTORE_DRILL_EVIDENCE_FILE"
		require_env_key "SUPPORT_LISTEN_HOST"
		require_env_key "SUPPORT_API_PORT"
		require_env_key "SUPPORT_WORKER_PORT"
		require_env_key "SUPPORT_OUTBOX_PUBLISHER_PORT"
		require_env_key "SUPPORT_INTERNAL_BASE_URL"
		require_env_key "SUPPORT_CORE_TOKEN"
		require_env_key "SUPPORT_WEBHOOK_PUBLIC_URL"
		require_env_key "SUPPORT_INBOX_LEASE_MS"
		require_env_key "SUPPORT_PREFETCH"
		require_env_key "SUPPORT_OUTBOX_BATCH_SIZE"
		require_env_key "SUPPORT_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "SUPPORT_OUTBOX_RETENTION_DAYS"
		require_env_key "SUPPORT_RECEIPT_RETENTION_DAYS"
		require_env_key "SUPPORT_FAILURE_DETAIL_RETENTION_DAYS"
		require_env_key "SUPPORT_RESTORE_DRILL_EVIDENCE_FILE"
		require_env_key "RECAPTCHA_CLIENT_URL"
		require_env_key "NOTIFICATION_DELIVERY_LISTEN_HOST"
		require_env_key "MAINTENANCE_WORKER_PREFETCH"
		require_env_key "MAINTENANCE_HEALTH_PORT"
		require_env_key "NOTIFICATION_DELIVERY_HEALTH_PORT"
		require_env_key "NOTIFICATION_DELIVERY_PREFETCH"
		require_env_key "SCHEDULED_JOB_POLL_INTERVAL_MS"
		require_env_key "SCHEDULED_JOB_LEASE_MS"
		require_env_key "SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS"
		require_env_key "INTEGRATION_WORKER_KINDS"
		require_env_key "MAINTENANCE_WORKER_KINDS"
		require_env_key "NOTIFICATION_DELIVERY_KINDS"
		require_env_exact_list \
			"INTEGRATION_WORKER_KINDS" \
			"$expected_integration_worker_kinds"
		require_env_exact_list \
			"MAINTENANCE_WORKER_KINDS" \
			"database-backup"
		require_env_exact_list \
			"NOTIFICATION_DELIVERY_KINDS" \
			"email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram"
		require_env_key "YOOKASSA_PRODUCTION_SHOP_ID"
		require_env_key "YOOKASSA_PRODUCTION_SECRET_KEY"
		require_env_key "PAYMENT_METHOD_ENCRYPTION_KEY"
		payment_method_key_bytes="$(
			printf '%s' "$(get_env_value PAYMENT_METHOD_ENCRYPTION_KEY)" |
				base64 -d 2>/dev/null |
				wc -c |
				tr -d '[:space:]'
		)"
		if [[ "$payment_method_key_bytes" != "32" ]]; then
			echo "PAYMENT_METHOD_ENCRYPTION_KEY must be standard base64 for exactly 32 bytes" >&2
			exit 1
		fi
		require_env_key "PORT"
		require_env_key "API_LISTEN_HOST"
		require_env_key "TRUST_PROXY"
		require_env_exact_list \
			"CORS_ALLOWED_ORIGINS" \
			"https://winwidget.ru,https://www.winwidget.ru"
		if [[ "$(get_env_value PORT)" != "4200" ]]; then
			echo "Production PORT must be 4200" >&2
			exit 1
		fi
		if [[ "$(get_env_value API_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production API_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value TRUST_PROXY)" != "loopback" ]]; then
			echo "Production TRUST_PROXY must be loopback" >&2
			exit 1
		fi
		if [[ "$(get_env_value PRODUCTION_HOST)" != "https://api.winwidget.ru" ]]; then
			echo "Production PRODUCTION_HOST must be https://api.winwidget.ru" >&2
			exit 1
		fi
		if [[ "$(get_env_value AUTH_COOKIE_DOMAIN)" != ".winwidget.ru" ]]; then
			echo "Production AUTH_COOKIE_DOMAIN must be .winwidget.ru so Next.js middleware and API share the refresh cookie" >&2
			exit 1
		fi
		if [[ "$(get_env_value JWT_ISSUER)" != "https://api.winwidget.ru/auth" ]]; then
			echo "Production JWT_ISSUER must be https://api.winwidget.ru/auth" >&2
			exit 1
		fi
		if [[ "$(get_env_value JWT_AUDIENCE)" != "https://api.winwidget.ru" ]]; then
			echo "Production JWT_AUDIENCE must be https://api.winwidget.ru" >&2
			exit 1
		fi
		if [[ "$(get_env_value GATEWAY_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production GATEWAY_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value GATEWAY_PORT)" != "4100" ]]; then
			echo "Production GATEWAY_PORT must be 4100" >&2
			exit 1
		fi
		if [[ "$(get_env_value MAINTENANCE_HEALTH_PORT)" != "4300" ]]; then
			echo "Production MAINTENANCE_HEALTH_PORT must be 4300" >&2
			exit 1
		fi
		if [[ "$(get_env_value NOTIFICATION_DELIVERY_HEALTH_PORT)" != "4401" ]]; then
			echo "Production NOTIFICATION_DELIVERY_HEALTH_PORT must be 4401" >&2
			exit 1
		fi
		if [[ "$(get_env_value NOTIFICATION_DELIVERY_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production NOTIFICATION_DELIVERY_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_URL)" != "http://127.0.0.1:4401/internal/notification-delivery" ]]; then
			echo "Production NOTIFICATION_DELIVERY_INTERNAL_URL must use the loopback notification delivery endpoint" >&2
			exit 1
		fi
		if [[ "$(get_env_value TELEGRAM_API_BASE_URL)" != "https://tg.winwidget.ru/telegram-api" ]]; then
			echo "Production TELEGRAM_API_BASE_URL must use the Telegram HTTPS reverse proxy endpoint" >&2
			exit 1
		fi
		telegram_api_proxy_ip="$(get_env_value TELEGRAM_API_PROXY_IP)"
		if ! validate_ipv4_address "$telegram_api_proxy_ip" ||
			[[ "$telegram_api_proxy_ip" != '185.184.122.62' ]]; then
			echo "Production TELEGRAM_API_PROXY_IP must be the reviewed public relay 185.184.122.62" >&2
			exit 1
		fi
		if ! verify_telegram_https_reverse_proxy "$telegram_api_proxy_ip"; then
			echo "Telegram HTTPS reverse proxy preflight failed" >&2
			exit 1
		fi
		notification_delivery_internal_token="$(
			get_env_value NOTIFICATION_DELIVERY_INTERNAL_TOKEN
		)"
		if [[ "$notification_delivery_internal_token" == "XYZXYZXYZ" ||
			"$notification_delivery_internal_token" == change_me* ||
			${#notification_delivery_internal_token} -lt 32 ]]; then
			echo "NOTIFICATION_DELIVERY_INTERNAL_TOKEN must be a non-placeholder value of at least 32 characters" >&2
			exit 1
		fi
		notification_delivery_internal_timeout_ms="$(
			get_env_value NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS || true
		)"
		notification_delivery_internal_timeout_ms="${notification_delivery_internal_timeout_ms:-5000}"
		if [[ ! "$notification_delivery_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((notification_delivery_internal_timeout_ms < 500 ||
				notification_delivery_internal_timeout_ms > 30000)); then
			echo "NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS must be between 500 and 30000" >&2
			exit 1
		fi
		notification_delivery_prefetch="$(
			get_env_value NOTIFICATION_DELIVERY_PREFETCH
		)"
		if [[ ! "$notification_delivery_prefetch" =~ ^[1-9][0-9]*$ ]] ||
			((notification_delivery_prefetch > 100)); then
			echo "NOTIFICATION_DELIVERY_PREFETCH must be between 1 and 100" >&2
			exit 1
			fi
		campaigns_internal_token="$(get_env_value CAMPAIGNS_INTERNAL_TOKEN)"
		if [[ "$campaigns_internal_token" == change_me* ||
			"$campaigns_internal_token" == "ci_campaigns_internal_token_at_least_32_chars" ||
			${#campaigns_internal_token} -lt 32 ]]; then
			echo "CAMPAIGNS_INTERNAL_TOKEN must be a production-only secret of at least 32 characters" >&2
			exit 1
		fi
		if [[ "$(get_env_value CAMPAIGNS_PROCESS_ROLE)" != "all" ||
			"$(get_env_value CAMPAIGNS_LISTEN_HOST)" != "127.0.0.1" ||
			"$(get_env_value CAMPAIGNS_HEALTH_PORT)" != "4500" ||
			"$(get_env_value CAMPAIGNS_CORE_INTERNAL_BASE_URL)" != "http://127.0.0.1:4200" ]]; then
			echo "Campaigns must run as the loopback-only single-VPS all role on ports 4200/4500" >&2
			exit 1
		fi
		campaigns_internal_timeout_ms="$(
			get_env_value CAMPAIGNS_INTERNAL_TIMEOUT_MS
		)"
		campaigns_export_chunk_size="$(
			get_env_value CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE
		)"
		campaigns_export_timeout_ms="$(
			get_env_value CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS
		)"
		campaigns_import_batch_size="$(
			get_env_value CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE
		)"
		campaigns_prefetch="$(get_env_value CAMPAIGNS_PREFETCH)"
		if [[ ! "$campaigns_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((campaigns_internal_timeout_ms < 500 ||
				campaigns_internal_timeout_ms > 30000)); then
			echo "CAMPAIGNS_INTERNAL_TIMEOUT_MS must be between 500 and 30000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_export_chunk_size" =~ ^[0-9]+$ ]] ||
			((campaigns_export_chunk_size < 1 ||
				campaigns_export_chunk_size > 5000)); then
			echo "CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE must be between 1 and 5000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_export_timeout_ms" =~ ^[0-9]+$ ]] ||
			((campaigns_export_timeout_ms < 30000 ||
				campaigns_export_timeout_ms > 900000)); then
			echo "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS must be between 30000 and 900000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_import_batch_size" =~ ^[0-9]+$ ]] ||
			((campaigns_import_batch_size < 1 ||
				campaigns_import_batch_size > 5000)); then
			echo "CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE must be between 1 and 5000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_prefetch" =~ ^[1-9][0-9]*$ ]] ||
			((campaigns_prefetch > 100)); then
			echo "CAMPAIGNS_PREFETCH must be between 1 and 100" >&2
			exit 1
		fi
		reporting_validate_preflight_secret_isolation || {
			echo 'Reporting credential isolation preflight failed.' >&2
			exit 1
		}
		if [[ "$(get_env_value REPORTING_PROCESS_ROLE)" != "all" ||
			"$(get_env_value REPORTING_LISTEN_HOST)" != "127.0.0.1" ||
			"$(get_env_value REPORTING_PORT)" != "4600" ||
			"$(get_env_value REPORTING_CORE_INTERNAL_BASE_URL)" != "http://127.0.0.1:4200" ]]; then
			echo "Reporting must run as the loopback-only single-VPS all role on ports 4200/4600" >&2
			exit 1
		fi
		reporting_scheduler_enabled="$(get_env_value REPORTING_SCHEDULER_ENABLED)"
		if [[ "$reporting_scheduler_policy" == 'transitional' ||
			"$reporting_scheduler_policy" == 'fenced' ]]; then
			echo 'A coordinated full deployment is blocked during the Daily Summary owner hand-off; use the Reporting-only target.' >&2
			exit 1
		fi
		if ! reporting_cutover_scheduler_value_allowed \
			"$reporting_scheduler_policy" "$reporting_scheduler_enabled"; then
			echo "REPORTING_SCHEDULER_ENABLED=$reporting_scheduler_enabled conflicts with cutover policy $reporting_scheduler_policy" >&2
			exit 1
		fi
		reporting_internal_token="$(get_env_value REPORTING_INTERNAL_TOKEN)"
		if [[ "$reporting_internal_token" == change_me* ||
			"$reporting_internal_token" == "ci_reporting_internal_token_at_least_32_chars" ||
			${#reporting_internal_token} -lt 32 ]]; then
			echo "REPORTING_INTERNAL_TOKEN must be a production-only secret of at least 32 characters" >&2
			exit 1
		fi
		unset reporting_internal_token
		reporting_internal_timeout_ms="$(get_env_value REPORTING_INTERNAL_TIMEOUT_MS)"
		reporting_prefetch="$(get_env_value REPORTING_PREFETCH)"
		reporting_outbox_batch_size="$(get_env_value REPORTING_OUTBOX_BATCH_SIZE)"
		reporting_outbox_poll_interval_ms="$(get_env_value REPORTING_OUTBOX_POLL_INTERVAL_MS)"
		reporting_outbox_retention_days="$(get_env_value REPORTING_OUTBOX_RETENTION_DAYS)"
		if [[ ! "$reporting_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((reporting_internal_timeout_ms < 500 ||
				reporting_internal_timeout_ms > 60000)); then
			echo "REPORTING_INTERNAL_TIMEOUT_MS must be between 500 and 60000" >&2
			exit 1
		fi
		if [[ ! "$reporting_prefetch" =~ ^[1-9][0-9]*$ ]] ||
			((reporting_prefetch > 100)); then
			echo "REPORTING_PREFETCH must be between 1 and 100" >&2
			exit 1
		fi
		if [[ ! "$reporting_outbox_batch_size" =~ ^[1-9][0-9]*$ ]] ||
			((reporting_outbox_batch_size > 500)); then
			echo "REPORTING_OUTBOX_BATCH_SIZE must be between 1 and 500" >&2
			exit 1
		fi
		if [[ ! "$reporting_outbox_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((reporting_outbox_poll_interval_ms < 100 ||
				reporting_outbox_poll_interval_ms > 60000)); then
			echo "REPORTING_OUTBOX_POLL_INTERVAL_MS must be between 100 and 60000" >&2
			exit 1
		fi
		if [[ ! "$reporting_outbox_retention_days" =~ ^[1-9][0-9]*$ ]] ||
			((reporting_outbox_retention_days > 365)); then
			echo "REPORTING_OUTBOX_RETENTION_DAYS must be between 1 and 365" >&2
			exit 1
		fi
		if [[ "$(get_env_value WIDGETS_PROCESS_ROLE)" != "all" ||
			"$(get_env_value WIDGETS_LISTEN_HOST)" != "127.0.0.1" ||
			"$(get_env_value WIDGETS_PORT)" != "4700" ||
			"$(get_env_value WIDGETS_CORE_INTERNAL_BASE_URL)" != "http://127.0.0.1:4200" ||
			"$(get_env_value WIDGETS_INTERNAL_BASE_URL)" != "http://127.0.0.1:4700" ]]; then
			echo 'Widgets must run as the loopback-only single-VPS all role on ports 4200/4700.' >&2
			exit 1
		fi
		widgets_internal_token="$(get_env_value WIDGETS_INTERNAL_TOKEN)"
		if [[ "$widgets_internal_token" == change_me* ||
			"$widgets_internal_token" == 'ci_widgets_internal_token_for_isolated_verify_20260804' ||
			${#widgets_internal_token} -lt 32 ]]; then
			echo 'WIDGETS_INTERNAL_TOKEN must be a production-only secret of at least 32 characters.' >&2
			exit 1
		fi
		unset widgets_internal_token
		widgets_internal_timeout_ms="$(get_env_value WIDGETS_INTERNAL_TIMEOUT_MS)"
		widgets_entitlement_max_staleness_ms="$(get_env_value WIDGETS_ENTITLEMENT_MAX_STALENESS_MS)"
		widgets_prefetch="$(get_env_value WIDGETS_PREFETCH)"
		widgets_outbox_batch_size="$(get_env_value WIDGETS_OUTBOX_BATCH_SIZE)"
		widgets_outbox_poll_interval_ms="$(get_env_value WIDGETS_OUTBOX_POLL_INTERVAL_MS)"
		widgets_outbox_retention_days="$(get_env_value WIDGETS_OUTBOX_RETENTION_DAYS)"
		widgets_receipt_retention_days="$(get_env_value WIDGETS_RECEIPT_RETENTION_DAYS)"
		widgets_failure_detail_retention_days="$(get_env_value WIDGETS_FAILURE_DETAIL_RETENTION_DAYS)"
		if [[ ! "$widgets_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((widgets_internal_timeout_ms < 500 || widgets_internal_timeout_ms > 60000)) ||
			[[ ! "$widgets_entitlement_max_staleness_ms" =~ ^[0-9]+$ ]] ||
			((widgets_entitlement_max_staleness_ms < 60000 ||
				widgets_entitlement_max_staleness_ms > 31968000000)) ||
			[[ ! "$widgets_prefetch" =~ ^[1-9][0-9]*$ ]] || ((widgets_prefetch > 100)) ||
			[[ ! "$widgets_outbox_batch_size" =~ ^[1-9][0-9]*$ ]] || ((widgets_outbox_batch_size > 500)) ||
			[[ ! "$widgets_outbox_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((widgets_outbox_poll_interval_ms < 100 || widgets_outbox_poll_interval_ms > 60000)) ||
			[[ ! "$widgets_outbox_retention_days" =~ ^[1-9][0-9]*$ ]] || ((widgets_outbox_retention_days > 365)) ||
			[[ ! "$widgets_receipt_retention_days" =~ ^[1-9][0-9]*$ ]] || ((widgets_receipt_retention_days > 730)) ||
			[[ ! "$widgets_failure_detail_retention_days" =~ ^[1-9][0-9]*$ ]] || ((widgets_failure_detail_retention_days > 365)); then
			echo 'Widgets timeout, entitlement staleness, prefetch, Outbox and retention settings are outside the reviewed bounds.' >&2
			exit 1
		fi
		if [[ "$(get_env_value BILLING_LISTEN_HOST)" != '127.0.0.1' ||
			"$(get_env_value BILLING_API_PORT)" != '4800' ||
			"$(get_env_value BILLING_SCHEDULER_PORT)" != '4801' ||
			"$(get_env_value BILLING_WORKER_PORT)" != '4802' ||
			"$(get_env_value BILLING_OUTBOX_PUBLISHER_PORT)" != '4803' ||
			"$(get_env_value BILLING_INTERNAL_BASE_URL)" != 'http://127.0.0.1:4800' ||
			"$(get_env_value BILLING_CORE_INTERNAL_BASE_URL)" != 'http://127.0.0.1:4200' ]]; then
			echo 'Billing runtime must use the reviewed loopback hosts and ports 4800-4803.' >&2
			exit 1
		fi
		billing_internal_token="$(get_env_value BILLING_INTERNAL_TOKEN)"
		if [[ "$billing_internal_token" == change_me* ||
			"$billing_internal_token" == 'ci_billing_internal_token_at_least_32_chars' ||
			${#billing_internal_token} -lt 32 ||
			"$billing_internal_token" == "$(get_env_value WIDGETS_INTERNAL_TOKEN)" ]]; then
			echo 'BILLING_INTERNAL_TOKEN must be a unique production-only secret of at least 32 characters.' >&2
			exit 1
		fi
		unset billing_internal_token
		billing_internal_timeout_ms="$(get_env_value BILLING_INTERNAL_TIMEOUT_MS)"
		billing_prefetch="$(get_env_value BILLING_PREFETCH)"
		billing_outbox_batch_size="$(get_env_value BILLING_OUTBOX_BATCH_SIZE)"
		billing_outbox_poll_interval_ms="$(get_env_value BILLING_OUTBOX_POLL_INTERVAL_MS)"
		billing_outbox_retention_days="$(get_env_value BILLING_OUTBOX_RETENTION_DAYS)"
		billing_receipt_retention_days="$(get_env_value BILLING_RECEIPT_RETENTION_DAYS)"
		billing_failure_detail_retention_days="$(get_env_value BILLING_FAILURE_DETAIL_RETENTION_DAYS)"
		if [[ ! "$billing_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((billing_internal_timeout_ms < 500 || billing_internal_timeout_ms > 60000)) ||
			[[ ! "$billing_prefetch" =~ ^[1-9][0-9]*$ ]] || ((billing_prefetch > 100)) ||
			[[ ! "$billing_outbox_batch_size" =~ ^[1-9][0-9]*$ ]] || ((billing_outbox_batch_size > 500)) ||
			[[ ! "$billing_outbox_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((billing_outbox_poll_interval_ms < 100 || billing_outbox_poll_interval_ms > 60000)) ||
			[[ ! "$billing_outbox_retention_days" =~ ^[1-9][0-9]*$ ]] || ((billing_outbox_retention_days > 365)) ||
			[[ ! "$billing_receipt_retention_days" =~ ^[1-9][0-9]*$ ]] || ((billing_receipt_retention_days > 730)) ||
			[[ ! "$billing_failure_detail_retention_days" =~ ^[1-9][0-9]*$ ]] || ((billing_failure_detail_retention_days > 365)); then
			echo 'Billing timeout, prefetch, Outbox and retention settings are outside the reviewed bounds.' >&2
			exit 1
		fi
		if [[ "$(get_env_value IDENTITY_POSTGRES_PORT)" != '55438' ||
			"$(get_env_value IDENTITY_POSTGRES_ADMIN_USER)" != 'winwidget_identity_admin' ||
			"$(get_env_value IDENTITY_LISTEN_HOST)" != '127.0.0.1' ||
			"$(get_env_value IDENTITY_API_PORT)" != '4900' ||
			"$(get_env_value IDENTITY_WORKER_PORT)" != '4901' ||
			"$(get_env_value IDENTITY_OUTBOX_PUBLISHER_PORT)" != '4902' ||
			"$(get_env_value IDENTITY_INTERNAL_BASE_URL)" != 'http://127.0.0.1:4900' ||
			"$(get_env_value IDENTITY_INTERNAL_TIMEOUT_MS)" != '5000' ]]; then
			echo 'Identity must use the reviewed database, loopback HTTP and process-role ports.' >&2
			exit 1
		fi
		if [[ "$identity_cleanup_phase" != 'complete' ]] &&
			[[ "$(get_env_value IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64)" == "$(get_env_value JWT_ACCESS_PRIVATE_KEY_BASE64)" ||
				"$(get_env_value IDENTITY_JWT_ACCESS_JWKS_BASE64)" == "$(get_env_value JWT_ACCESS_JWKS_BASE64)" ||
				"$(get_env_value IDENTITY_JWT_ACCESS_ACTIVE_KID)" == "$(get_env_value JWT_ACCESS_ACTIVE_KID)" ]]; then
			echo 'Identity signing material must be rotated and distinct from the legacy Core keyset.' >&2
			exit 1
		fi
		identity_prefetch="$(get_env_value IDENTITY_PREFETCH)"
		identity_outbox_batch_size="$(get_env_value IDENTITY_OUTBOX_BATCH_SIZE)"
		identity_outbox_poll_interval_ms="$(get_env_value IDENTITY_OUTBOX_POLL_INTERVAL_MS)"
		identity_outbox_retention_days="$(get_env_value IDENTITY_OUTBOX_RETENTION_DAYS)"
		identity_receipt_retention_days="$(get_env_value IDENTITY_RECEIPT_RETENTION_DAYS)"
		identity_failure_detail_retention_days="$(get_env_value IDENTITY_FAILURE_DETAIL_RETENTION_DAYS)"
		identity_core_cleanup_soak_seconds="$(get_env_value IDENTITY_CORE_CLEANUP_SOAK_SECONDS)"
		if [[ ! "$identity_prefetch" =~ ^[1-9][0-9]*$ ]] || ((identity_prefetch > 100)) ||
			[[ ! "$identity_outbox_batch_size" =~ ^[1-9][0-9]*$ ]] || ((identity_outbox_batch_size > 500)) ||
			[[ ! "$identity_outbox_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((identity_outbox_poll_interval_ms < 100 || identity_outbox_poll_interval_ms > 60000)) ||
			[[ ! "$identity_outbox_retention_days" =~ ^[1-9][0-9]*$ ]] || ((identity_outbox_retention_days > 365)) ||
			[[ ! "$identity_receipt_retention_days" =~ ^[1-9][0-9]*$ ]] || ((identity_receipt_retention_days > 730)) ||
			[[ ! "$identity_failure_detail_retention_days" =~ ^[1-9][0-9]*$ ]] || ((identity_failure_detail_retention_days > 365)) ||
			[[ ! "$identity_core_cleanup_soak_seconds" =~ ^[0-9]+$ ]] ||
			((identity_core_cleanup_soak_seconds < 900 || identity_core_cleanup_soak_seconds > 86400)); then
			echo 'Identity prefetch, Outbox and retention settings are outside the reviewed bounds.' >&2
			exit 1
		fi
		platform_outbox_batch_size="$(get_env_value PLATFORM_OUTBOX_BATCH_SIZE)"
		platform_outbox_poll_interval_ms="$(get_env_value PLATFORM_OUTBOX_POLL_INTERVAL_MS)"
		platform_outbox_retention_days="$(get_env_value PLATFORM_OUTBOX_RETENTION_DAYS)"
		if [[ "$(get_env_value PLATFORM_POSTGRES_PORT)" != '55439' ||
			"$(get_env_value PLATFORM_LISTEN_HOST)" != '127.0.0.1' ||
			"$(get_env_value PLATFORM_API_PORT)" != '5000' ||
			"$(get_env_value PLATFORM_OUTBOX_PUBLISHER_PORT)" != '5001' ||
			"$(get_env_value PLATFORM_INTERNAL_BASE_URL)" != 'http://127.0.0.1:5000' ||
			"$(get_env_value PLATFORM_INTERNAL_TIMEOUT_MS)" != '5000' ||
			! "$platform_outbox_batch_size" =~ ^[1-9][0-9]*$ ]] ||
			((platform_outbox_batch_size > 500)) ||
			[[ ! "$platform_outbox_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((platform_outbox_poll_interval_ms < 100 || platform_outbox_poll_interval_ms > 60000)) ||
			[[ ! "$platform_outbox_retention_days" =~ ^[1-9][0-9]*$ ]] ||
			((platform_outbox_retention_days > 365)); then
			echo 'Platform must use the reviewed database, loopback boundary, ports and bounded Outbox settings.' >&2
			exit 1
		fi
		support_inbox_lease_ms="$(get_env_value SUPPORT_INBOX_LEASE_MS)"
		support_prefetch="$(get_env_value SUPPORT_PREFETCH)"
		support_outbox_batch_size="$(get_env_value SUPPORT_OUTBOX_BATCH_SIZE)"
		support_outbox_poll_interval_ms="$(get_env_value SUPPORT_OUTBOX_POLL_INTERVAL_MS)"
		support_outbox_retention_days="$(get_env_value SUPPORT_OUTBOX_RETENTION_DAYS)"
		support_receipt_retention_days="$(get_env_value SUPPORT_RECEIPT_RETENTION_DAYS)"
		support_failure_detail_retention_days="$(get_env_value SUPPORT_FAILURE_DETAIL_RETENTION_DAYS)"
		if [[ "$(get_env_value SUPPORT_POSTGRES_PORT)" != '55440' ||
			"$(get_env_value SUPPORT_POSTGRES_ADMIN_USER)" != 'winwidget_support_admin' ||
			"$(get_env_value SUPPORT_LISTEN_HOST)" != '127.0.0.1' ||
			"$(get_env_value SUPPORT_API_PORT)" != '5100' ||
			"$(get_env_value SUPPORT_WORKER_PORT)" != '5101' ||
			"$(get_env_value SUPPORT_OUTBOX_PUBLISHER_PORT)" != '5102' ||
			"$(get_env_value SUPPORT_INTERNAL_BASE_URL)" != 'http://127.0.0.1:5100' ||
			"$(get_env_value SUPPORT_WEBHOOK_PUBLIC_URL)" != 'https://tg.winwidget.ru/api/v1/telegram-bot/support-webhook' ||
			! "$support_inbox_lease_ms" =~ ^[0-9]+$ ]] ||
			((support_inbox_lease_ms < 30000 || support_inbox_lease_ms > 600000)) ||
			[[ ! "$support_prefetch" =~ ^[1-9][0-9]*$ ]] || ((support_prefetch > 100)) ||
			[[ ! "$support_outbox_batch_size" =~ ^[1-9][0-9]*$ ]] || ((support_outbox_batch_size > 500)) ||
			[[ ! "$support_outbox_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((support_outbox_poll_interval_ms < 100 || support_outbox_poll_interval_ms > 60000)) ||
			[[ ! "$support_outbox_retention_days" =~ ^[1-9][0-9]*$ ]] || ((support_outbox_retention_days > 365)) ||
			[[ ! "$support_receipt_retention_days" =~ ^[1-9][0-9]*$ ]] || ((support_receipt_retention_days > 730)) ||
			[[ ! "$support_failure_detail_retention_days" =~ ^[1-9][0-9]*$ ]] || ((support_failure_detail_retention_days > 365)); then
			echo 'Support must use the reviewed PG18 boundary, loopback ports, public Telegram relay and bounded retry settings.' >&2
			exit 1
		fi
		identity_credential_keys=(
			IDENTITY_CORE_TOKEN CORE_IDENTITY_TOKEN IDENTITY_CAMPAIGNS_TOKEN
			IDENTITY_REPORTING_TOKEN IDENTITY_WIDGETS_TOKEN IDENTITY_BILLING_TOKEN
			IDENTITY_PLATFORM_TOKEN IDENTITY_SUPPORT_TOKEN
			BILLING_CAMPAIGNS_TOKEN BILLING_IDENTITY_TOKEN WIDGETS_IDENTITY_TOKEN
			PLATFORM_CORE_TOKEN SUPPORT_CORE_TOKEN
		)
		identity_credentials=()
		for identity_credential_key in "${identity_credential_keys[@]}"; do
			identity_credential_value="$(get_env_value "$identity_credential_key")"
			if [[ "$identity_credential_value" == change_me* ||
				"$identity_credential_value" == ci_* ||
				${#identity_credential_value} -lt 32 ||
				"$identity_credential_value" == "$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_TOKEN)" ||
				"$identity_credential_value" == "$(get_env_value CAMPAIGNS_INTERNAL_TOKEN)" ||
				"$identity_credential_value" == "$(get_env_value REPORTING_INTERNAL_TOKEN)" ||
				"$identity_credential_value" == "$(get_env_value WIDGETS_INTERNAL_TOKEN)" ||
				"$identity_credential_value" == "$(get_env_value BILLING_INTERNAL_TOKEN)" ]]; then
				echo "$identity_credential_key must be a production-only secret of at least 32 characters." >&2
				exit 1
			fi
			identity_credentials+=("$identity_credential_value")
		done
		for ((left = 0; left < ${#identity_credentials[@]}; left++)); do
			for ((right = left + 1; right < ${#identity_credentials[@]}; right++)); do
				[[ "${identity_credentials[$left]}" != "${identity_credentials[$right]}" ]] || {
					echo 'Cross-domain credentials must be audience-scoped and distinct.' >&2
					exit 1
				}
			done
		done
		unset identity_credential_key identity_credential_value
		require_env_base64url_secret DATABASE_RESTORE_QUEUE_SECRET 43 128
		database_restore_queue_secret="$(
			get_env_value DATABASE_RESTORE_QUEUE_SECRET
		)"
		if [[ "$database_restore_queue_secret" == 'ci_database_restore_queue_secret_at_least_32_chars' ||
			"$database_restore_queue_secret" == "$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value CAMPAIGNS_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value REPORTING_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value WIDGETS_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value BILLING_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value IDENTITY_CORE_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value CORE_IDENTITY_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value PAYMENT_METHOD_ENCRYPTION_KEY)" ]]; then
			echo 'DATABASE_RESTORE_QUEUE_SECRET must be a unique production-only secret.' >&2
			exit 1
		fi
		for identity_credential_value in "${identity_credentials[@]}"; do
			[[ "$database_restore_queue_secret" != "$identity_credential_value" ]] || {
				echo 'DATABASE_RESTORE_QUEUE_SECRET must differ from every cross-domain credential.' >&2
				exit 1
			}
		done
		unset identity_credentials identity_credential_value
		unset database_restore_queue_secret
		validate_routine_database_restore_create_gate "$ENV_FILE" || exit 1
		database_restore_poll_interval_ms="$(
			get_env_value DATABASE_RESTORE_POLL_INTERVAL_MS
		)"
		database_restore_command_timeout_ms="$(
			get_env_value DATABASE_RESTORE_COMMAND_TIMEOUT_MS
		)"
		if [[ ! "$database_restore_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((database_restore_poll_interval_ms < 250 ||
				database_restore_poll_interval_ms > 60000)); then
			echo 'DATABASE_RESTORE_POLL_INTERVAL_MS must be between 250 and 60000.' >&2
			exit 1
		fi
		if [[ ! "$database_restore_command_timeout_ms" =~ ^[0-9]+$ ]] ||
			((database_restore_command_timeout_ms < 60000 ||
				database_restore_command_timeout_ms > 7200000)); then
			echo 'DATABASE_RESTORE_COMMAND_TIMEOUT_MS must be between 60000 and 7200000.' >&2
			exit 1
		fi
		assert_database_restore_admin_secret_file \
			CORE_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.core-postgres-temporary-admin-password"
		assert_database_restore_admin_secret_file \
			NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.notification-delivery-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.campaigns-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			REPORTING_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.reporting-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			WIDGETS_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.widgets-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			BILLING_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.billing-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.identity-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			PLATFORM_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.platform-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			SUPPORT_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.support-postgres-admin-password"
		for smtp_timeout_key in \
			SMTP_CONNECTION_TIMEOUT_MS \
			SMTP_GREETING_TIMEOUT_MS \
			SMTP_SOCKET_TIMEOUT_MS; do
			smtp_timeout_value="$(get_env_value "$smtp_timeout_key")"
			if [[ ! "$smtp_timeout_value" =~ ^[0-9]+$ ]] ||
				((smtp_timeout_value < 1000 || smtp_timeout_value > 60000)); then
				echo "$smtp_timeout_key must be between 1000 and 60000" >&2
				exit 1
			fi
		done
		assert_distinct_database_roles
		expected_jwks_url="http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json"
		if [[ "$identity_routes_env_state" != 'identity' ||
			"$(get_env_value JWT_JWKS_URL)" != "$expected_jwks_url" ]]; then
			echo "Production JWT_JWKS_URL must use the loopback Identity JWKS endpoint" >&2
			exit 1
		fi
		for oauth_provider in google github yandex vk; do
			oauth_key="$(
				printf '%s' "$oauth_provider" |
					tr '[:lower:]' '[:upper:]'
			)_CALLBACK_URL"
			expected_oauth_callback="https://api.winwidget.ru/api/v1/auth/$oauth_provider/redirect"
			require_env_key "$oauth_key"
			if [[ "$(get_env_value "$oauth_key")" != "$expected_oauth_callback" ]]; then
				echo "$oauth_key must be $expected_oauth_callback" >&2
				exit 1
			fi
		done
		;;
	development)
		require_env_key "DATABASE_URL_DEVELOPMENT"
		require_env_key "YOOKASSA_SHOP_ID"
		require_env_key "YOOKASSA_SECRET_KEY"
		;;
	*)
		echo "Unsupported MODE in $ENV_FILE: $mode. Expected development or production." >&2
		exit 1
		;;
esac

jwt_access_ttl_seconds="$(get_env_value JWT_ACCESS_TTL_SECONDS)"
jwt_clock_tolerance_seconds="$(get_env_value JWT_CLOCK_TOLERANCE_SECONDS)"
if [[ ! "$jwt_access_ttl_seconds" =~ ^[0-9]+$ ]] ||
	((jwt_access_ttl_seconds < 300 || jwt_access_ttl_seconds > 1800)); then
	echo "JWT_ACCESS_TTL_SECONDS must be between 300 and 1800" >&2
	exit 1
fi
if [[ ! "$jwt_clock_tolerance_seconds" =~ ^[0-9]+$ ]] ||
	((jwt_clock_tolerance_seconds < 0 || jwt_clock_tolerance_seconds > 60)); then
	echo "JWT_CLOCK_TOLERANCE_SECONDS must be between 0 and 60" >&2
	exit 1
fi

target_project="$(get_env_value "COMPOSE_PROJECT_NAME" || true)"
if [[ "$target_project" != "winwidget" ]]; then
	echo "COMPOSE_PROJECT_NAME must be winwidget, got: ${target_project:-empty}" >&2
	exit 1
fi
assert_core_database_production_boundary
assert_notification_database_postgres_identity
assert_campaigns_database_postgres_identity
if [[ "$mode" == 'production' ]]; then
	prepare_database_restore_storage
fi
rabbitmq_vhost="$(get_env_value "RABBITMQ_VHOST" || true)"
if [[ "$rabbitmq_vhost" != "winwidget" ]]; then
	echo "RABBITMQ_VHOST must be winwidget, got: ${rabbitmq_vhost:-empty}" >&2
	exit 1
fi
rabbitmq_management_url="$(
	get_env_value "RABBITMQ_MANAGEMENT_URL" || true
)"
rabbitmq_management_url="${rabbitmq_management_url:-http://127.0.0.1:15672}"
if [[ "$rabbitmq_management_url" != "http://127.0.0.1:15672" ]]; then
	echo "RABBITMQ_MANAGEMENT_URL must use the loopback production endpoint" >&2
	exit 1
fi
rabbitmq_data_volume="$(get_env_value "RABBITMQ_DATA_VOLUME" || true)"
if ! docker volume inspect "$rabbitmq_data_volume" >/dev/null 2>&1; then
	echo "Verified RabbitMQ volume does not exist: $rabbitmq_data_volume" >&2
	echo "Determine the current /var/lib/rabbitmq volume before deployment; do not create a replacement blindly." >&2
	exit 1
fi
export COMPOSE_PROJECT_NAME="$target_project"
export RABBITMQ_DATA_VOLUME="$rabbitmq_data_volume"

rabbitmq_container_ids="$(
	docker ps -a \
		--filter label=com.docker.compose.service=rabbitmq \
		--format '{{.ID}}'
)"
matched_rabbitmq_containers=0
matched_rabbitmq_container_id=""
matched_rabbitmq_project=""
while IFS= read -r container_id; do
	[[ -n "$container_id" ]] || continue
	mounted_volume="$(
		docker inspect --format \
			'{{ range .Mounts }}{{ if eq .Destination "/var/lib/rabbitmq" }}{{ .Name }}{{ end }}{{ end }}' \
			"$container_id"
	)"
	if [[ "$mounted_volume" != "$rabbitmq_data_volume" ]]; then
		continue
	fi
	matched_rabbitmq_containers=$((matched_rabbitmq_containers + 1))
	matched_rabbitmq_container_id="$container_id"
	matched_rabbitmq_project="$(
		docker inspect --format \
			'{{ index .Config.Labels "com.docker.compose.project" }}' \
			"$container_id"
	)"
done <<<"$rabbitmq_container_ids"
if ((matched_rabbitmq_containers > 1)); then
	echo "More than one RabbitMQ container uses volume $rabbitmq_data_volume" >&2
	exit 1
fi
if [[ -n "$matched_rabbitmq_container_id" &&
	"$matched_rabbitmq_project" != "$target_project" ]]; then
	echo "RabbitMQ volume is attached to non-canonical Compose project: ${matched_rabbitmq_project:-unknown}" >&2
	echo "Resolve the stale project manually before deployment; automatic legacy cutover is not supported." >&2
	exit 1
fi

routine_compose_starts_integration_worker() {
	local argument command='' includes_integration_worker=false
	for argument in "$@"; do
		case "$argument" in
		up | start | restart) command="$argument" ;;
		integration-worker) includes_integration_worker=true ;;
		esac
	done
	[[ "$command" =~ ^(up|start|restart)$ &&
		"$includes_integration_worker" == true ]]
}

routine_require_platform_admin_audit_topology() {
	platform_cutover_provision_platform_admin_audit_topology || return 1
	platform_cutover_assert_platform_admin_audit_topology
}

compose_target() {
	if routine_compose_starts_integration_worker "$@"; then
		routine_require_platform_admin_audit_topology || return 1
	fi
	docker compose --project-name "$target_project" \
		--env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_notification_cutover() {
	if routine_compose_starts_integration_worker "$@"; then
		routine_require_platform_admin_audit_topology || return 1
	fi
	docker compose --project-name "$NOTIFICATION_DELIVERY_CUTOVER_PROJECT" \
		--env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

readonly CORE_NOTIFICATION_DELIVERY_OUTCOME_ROUTING_KEY='notification.delivery.outcome.v1'
readonly REPORTING_NOTIFICATION_DELIVERY_OUTCOME_ROUTING_KEY='reporting.notification.delivery.outcome.v1'
readonly CORE_NOTIFICATION_DELIVERY_OUTCOME_QUEUE='winwidget.notification.delivery-outcome'
readonly REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE='winwidget.reporting.delivery-outcome'

reporting_outcome_route_topology_state() {
	local rabbitmq_container_id bindings old_count new_count

	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq 2>/dev/null || true
	)"
	[[ -n "$rabbitmq_container_id" &&
		"$rabbitmq_container_id" != *$'\n'* ]] || {
		echo 'Exactly one running RabbitMQ container is required to inspect Reporting outcome routing.' >&2
		return 1
	}
	bindings="$(
		docker exec "$rabbitmq_container_id" \
			rabbitmqctl --silent list_bindings -p "$rabbitmq_vhost" \
				source_name destination_name routing_key
	)"
	old_count="$(
		reporting_binding_count "$bindings" winwidget.events \
			"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE" \
			"$CORE_NOTIFICATION_DELIVERY_OUTCOME_ROUTING_KEY"
	)"
	new_count="$(
		reporting_binding_count "$bindings" winwidget.events \
			"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE" \
			"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_ROUTING_KEY"
	)"
	[[ "$old_count" =~ ^[01]$ && "$new_count" =~ ^[01]$ ]] || {
		echo "Reporting outcome binding count is ambiguous: old=$old_count new=$new_count." >&2
		return 1
	}
	case "$old_count|$new_count" in
	1\|0) printf 'legacy\n' ;;
	0\|1) printf 'steady\n' ;;
	1\|1) printf 'dual\n' ;;
	0\|0) printf 'forward\n' ;;
	esac
}

reporting_outcome_route_data_state() {
	local notification_state core_state reporting_state

	notification_state="$(
		docker run --rm --network host \
			--env-file "$ENV_FILE" \
			--entrypoint node \
			"$NOTIFICATION_DELIVERY_IMAGE" \
			-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");
const prisma = new PrismaClient({
	datasources: {
		db: { url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL },
	},
});

prisma.notificationDeliveryOutboxEvent
	.count({
		where: {
			eventType: "notification.delivery.outcome.v1",
			status: { not: "PUBLISHED" },
			payload: {
				path: ["sourceKind"],
				equals: "daily-summary-delivery-telegram",
			},
		},
	})
	.then(count => process.stdout.write(String(count)))
	.finally(() => prisma.$disconnect());
'
	)" || {
		echo 'Could not inspect Notification Delivery state for the Reporting outcome route split.' >&2
		return 1
	}
	core_state="$(
		reporting_core_psql --tuples-only --no-align --field-separator='|' <<'SQL'
SELECT
  (
    SELECT COUNT(*)::TEXT
    FROM "integration_delivery_failures"
    WHERE "integration" = 'notification-delivery-outcome'
      AND "resolved_at" IS NULL
      AND "payload"->>'sourceKind' = 'daily-summary-delivery-telegram'
  ),
  (
    SELECT COUNT(*)::TEXT
    FROM "outbox_events"
    WHERE "routing_key" = 'notification.delivery.outcome.v1'
      AND "status"::TEXT <> 'PUBLISHED'
      AND "payload"->>'sourceKind' = 'daily-summary-delivery-telegram'
  );
SQL
	)" || {
		echo 'Could not inspect Core outcome state for the Reporting route split.' >&2
		return 1
	}
	reporting_state="$(
		reporting_database_psql REPORTING_DATABASE_URL \
			--tuples-only --no-align --field-separator='|' <<'SQL'
SELECT
  (
    SELECT COUNT(*)::TEXT
    FROM reporting.consumer_failures
    WHERE consumer_kind = 'deliveryOutcome'
      AND status::TEXT <> 'RESOLVED'
  ),
  (
    SELECT COUNT(*)::TEXT
    FROM reporting.consumer_receipts
    WHERE consumer = 'reporting-delivery-outcome-v1'
      AND status::TEXT IN ('PROCESSING', 'RETRY_SCHEDULED')
  ),
  (
    SELECT COUNT(*)::TEXT
    FROM reporting.report_runs
    WHERE status::TEXT = 'WAITING_DELIVERY'
  );
SQL
	)" || {
		echo 'Could not inspect Reporting delivery outcome state.' >&2
		return 1
	}
	printf '%s|%s|%s\n' "$notification_state" "$core_state" "$reporting_state"
}

reporting_outcome_route_is_drained() {
	local state notification_outbox core_failures core_outbox
	local reporting_failures reporting_receipts
	local reporting_waiting value

	state="$(reporting_outcome_route_data_state)" || return 1
	IFS='|' read -r \
		notification_outbox core_failures core_outbox \
		reporting_failures reporting_receipts \
		reporting_waiting <<<"$state"
	for value in \
		"$notification_outbox" "$core_failures" "$core_outbox" \
		"$reporting_failures" \
		"$reporting_receipts" "$reporting_waiting"; do
		[[ "$value" =~ ^[0-9]+$ ]] || {
			echo "Reporting outcome drain state is invalid: $state" >&2
			return 1
		}
	done
	if [[ "$state" != '0|0|0|0|0|0' ]]; then
		echo "Reporting outcome route split is blocked by durable state: $state" >&2
		echo 'Expected old Notification/Core outbox, unresolved Core/Reporting failures, active Reporting receipts and waiting runs to all be zero.' >&2
		echo 'Resolve the existing daily-summary error with Close without retry, then run the deployment again.' >&2
		return 1
	fi
	return 0
}

reporting_outcome_route_queue_state() {
	local rabbitmq_container_id

	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq 2>/dev/null || true
	)"
	[[ -n "$rabbitmq_container_id" &&
		"$rabbitmq_container_id" != *$'\n'* ]] || {
		echo 'Exactly one running RabbitMQ container is required to inspect outcome queues.' >&2
		return 1
	}
	docker exec "$rabbitmq_container_id" \
		rabbitmqctl --silent list_queues -p "$rabbitmq_vhost" \
			name messages_ready messages_unacknowledged consumers
}

reporting_outcome_route_queues_are_empty() {
	local require_unused="${1:-false}" state queue queue_line
	local _name ready unacknowledged consumers

	state="$(reporting_outcome_route_queue_state)" || return 1
	for queue in \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE" \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.dead-letter" \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry.1" \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry.2" \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry.3" \
		"$CORE_NOTIFICATION_DELIVERY_OUTCOME_QUEUE" \
		"$CORE_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.dead-letter" \
		"$CORE_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry-v2.1" \
		"$CORE_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry-v2.2" \
		"$CORE_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry-v2.3"; do
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; exit }' <<<"$state"
		)"
		if [[ -z "$queue_line" ]]; then
			if [[ "$queue" == "$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE" ||
				"$queue" == "$CORE_NOTIFICATION_DELIVERY_OUTCOME_QUEUE" ]]; then
				echo "Required outcome queue is missing: $queue" >&2
				return 1
			fi
			continue
		fi
		read -r _name ready unacknowledged consumers <<<"$queue_line"
		[[ "$ready" == '0' && "$unacknowledged" == '0' ]] || {
			echo "Outcome queue is not empty: $queue ready=$ready unacknowledged=$unacknowledged." >&2
			return 1
		}
		if [[ "$require_unused" == 'true' && "$consumers" != '0' ]]; then
			echo "Outcome queue still has consumers: $queue consumers=$consumers." >&2
			return 1
		fi
	done
	return 0
}

wait_for_reporting_outcome_route_drain() {
	local attempt

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if reporting_outcome_route_is_drained &&
			reporting_outcome_route_queues_are_empty false; then
			echo 'Legacy Reporting outcome state and queues are drained.'
			return 0
		fi
		if ((attempt < HEALTHCHECK_ATTEMPTS)); then
			sleep "$HEALTHCHECK_INTERVAL"
		fi
	done
	echo 'Reporting outcome state did not drain before the route split.' >&2
	return 1
}

prepare_reporting_outcome_route_cutover_after_stop() {
	local topology_state rabbitmq_container_id queue

	topology_state="$(reporting_outcome_route_topology_state)" || return 1
	if [[ "$topology_state" == 'steady' &&
		"$reporting_interrupted_routine_recovery" != 'true' ]]; then
		return 0
	fi
	reporting_outcome_route_is_drained || return 1
	reporting_outcome_route_queues_are_empty true || return 1
	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq 2>/dev/null || true
	)"

	if [[ "$topology_state" == 'legacy' || "$topology_state" == 'dual' ]]; then
		docker run --rm --network host \
			--env-file "$ENV_FILE" \
			-e "REPORTING_OLD_OUTCOME_ROUTE=$CORE_NOTIFICATION_DELIVERY_OUTCOME_ROUTING_KEY" \
			-e "REPORTING_OUTCOME_QUEUE=$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE" \
			--entrypoint node \
			"$REPORTING_IMAGE" \
			-e '
const amqp = require("amqplib");

(async () => {
	const connection = await amqp.connect(process.env.RABBITMQ_REPORTING_URL);
	try {
		const channel = await connection.createChannel();
		await channel.unbindQueue(
			process.env.REPORTING_OUTCOME_QUEUE,
			"winwidget.events",
			process.env.REPORTING_OLD_OUTCOME_ROUTE,
		);
		await channel.close();
	} finally {
		await connection.close();
	}
})().catch(error => {
	process.stderr.write(String(error && error.message ? error.message : error) + "\n");
	process.exitCode = 1;
});
'
	fi

	for queue in \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry.1" \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry.2" \
		"$REPORTING_NOTIFICATION_DELIVERY_OUTCOME_QUEUE.retry.3"; do
		if docker exec "$rabbitmq_container_id" \
			rabbitmqctl --silent list_queues -p "$rabbitmq_vhost" name |
			grep -Fqx -- "$queue"; then
			docker exec "$rabbitmq_container_id" \
				rabbitmqctl delete_queue -p "$rabbitmq_vhost" \
					"$queue" --if-empty --if-unused >/dev/null
		fi
	done
	topology_state="$(reporting_outcome_route_topology_state)" || return 1
	[[ "$topology_state" == 'forward' || "$topology_state" == 'steady' ]] || {
		echo "Reporting outcome route did not reach a forward-safe state: $topology_state." >&2
		return 1
	}
	echo 'Reporting outcome route and immutable retry topology converged.'
}

routine_stop_services=(
	api-gateway
	campaigns-service
	api
	outbox-publisher
	maintenance-worker
	database-restore-worker
	notification-delivery-worker
	integration-worker
	reporting-service
	widgets-service
	"${identity_runtime_services[@]}"
	"${support_runtime_services[@]}"
)
billing_core_cleanup_services=(
	"${routine_stop_services[@]}"
	billing-api
	billing-scheduler
	billing-worker
	billing-outbox-publisher
)
billing_core_cleanup_writer_manifest_rows=''
billing_core_cleanup_broker_manifest=''
billing_core_cleanup_require_staged_broker=false
declare -A routine_stop_container_ids=()
reporting_outcome_route_state_before='unknown'
reporting_interrupted_routine_recovery=false
reporting_cleanup_stop_recovery_active=false
# Remove this exact-image bootstrap after the first successful rollout verifies
# that the replacement API exits without Docker SIGKILL.
LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION="42c422ca4c2c3a8ce758a37773d6cb0e6b689db7"
LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID="sha256:e64d78b3dc511dde592641e979eb0b506b815f0e83c4eb943ac45b1780c3f554"
legacy_api_shutdown_bootstrap_observed=false

billing_core_cleanup_validate_staged_manifests() {
	local revision previous generation directory snapshot projection route output
	local writer_file queue_file
	revision="$(billing_core_source_cleanup_marker_value revision)" || return 1
	previous="$(billing_core_source_cleanup_marker_value previous_revision)" || return 1
	generation="$(billing_core_source_cleanup_marker_value ownership_generation)" || return 1
	snapshot="$(billing_core_source_cleanup_marker_value source_snapshot_sha256)" || return 1
	projection="$(billing_core_source_cleanup_marker_value projection_evidence_sha256)" || return 1
	route="$(billing_core_source_cleanup_marker_value route_evidence_sha256)" || return 1
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")" ||
		return 1
	writer_file="$directory/stopped-writers-evidence.json"
	queue_file="$directory/queue-drain-evidence.json"
	output="$(
		BILLING_WRITER_MANIFEST="$writer_file" BILLING_QUEUE_MANIFEST="$queue_file" \
			BILLING_PREVIOUS_REVISION="$previous" BILLING_CLEANUP_REVISION="$revision" \
			BILLING_CLEANUP_GENERATION="$generation" BILLING_SNAPSHOT_SHA="$snapshot" \
			BILLING_PROJECTION_SHA="$projection" BILLING_ROUTE_SHA="$route" billing_release_node - <<'NODE'
const fs = require('node:fs');
const exactKeys = (value, expected) => value && typeof value === 'object' &&
  !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) ===
  JSON.stringify([...expected].sort());
const isSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && !/^0+$/.test(value);
const isImage = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) && !/^sha256:0+$/.test(value);
const isRevision = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && !/^0+$/.test(value);
const isTimestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const previous = process.env.BILLING_PREVIOUS_REVISION;
const cleanup = process.env.BILLING_CLEANUP_REVISION;
const generation = Number(process.env.BILLING_CLEANUP_GENERATION);
const common = value => value.previousRevision === previous &&
  value.cleanupRevision === cleanup && value.ownershipGeneration === generation &&
  value.sourceSnapshotSha256 === process.env.BILLING_SNAPSHOT_SHA &&
  value.projectionEvidenceSha256 === process.env.BILLING_PROJECTION_SHA &&
  value.routeEvidenceSha256 === process.env.BILLING_ROUTE_SHA;
if (!isRevision(previous) || !isRevision(cleanup) || previous === cleanup || generation !== 2 ||
    !isSha(process.env.BILLING_SNAPSHOT_SHA) || !isSha(process.env.BILLING_PROJECTION_SHA) ||
    !isSha(process.env.BILLING_ROUTE_SHA)) process.exit(1);
const services = [
  'api-gateway', 'campaigns-service', 'api', 'outbox-publisher',
  'maintenance-worker', 'database-restore-worker', 'notification-delivery-worker',
  'integration-worker', 'reporting-service', 'widgets-service', 'billing-api',
  'billing-scheduler', 'billing-worker', 'billing-outbox-publisher',
];
const writer = read(process.env.BILLING_WRITER_MANIFEST);
if (!exactKeys(writer, ['schemaVersion','action','previousRevision','cleanupRevision',
    'ownershipGeneration','sourceSnapshotSha256','projectionEvidenceSha256',
    'routeEvidenceSha256','services','capturedAt']) || writer.schemaVersion !== 1 ||
    writer.action !== 'billing-core-source-cleanup-stopped-writers' || !common(writer) ||
    !isTimestamp(writer.capturedAt) || !Array.isArray(writer.services) ||
    writer.services.length !== services.length) process.exit(1);
for (let index = 0; index < services.length; index += 1) {
  const item = writer.services[index];
  if (!exactKeys(item, ['service','containerId','imageId','imageRevision','appRevision',
      'state','exitCode','oomKilled','error']) ||
      item.service !== services[index] || !/^[0-9a-f]{64}$/.test(item.containerId) ||
      !isImage(item.imageId) || item.imageRevision !== previous ||
      item.appRevision !== previous || item.state !== 'exited' ||
      ![0, 143].includes(item.exitCode) || item.oomKilled !== false || item.error !== '')
    process.exit(1);
}
const families = [
  'winwidget.billing.identity.v1',
  'winwidget.billing.offer.v1',
  'winwidget.billing.notification-routing.v1',
  'winwidget.billing.settings-source.v1',
  'winwidget.billing.trial.v1',
  'winwidget.billing.referral.v1',
  'winwidget.billing.lifecycle-repair.v1',
  'winwidget.payment.auto-renewal',
  'winwidget.billing.notification-delivery-outcome',
];
const expectedQueues = [];
for (const family of families) for (const suffix of ['', '.retry.1', '.retry.2', '.retry.3', '.dead-letter'])
  expectedQueues.push({ name: `${family}${suffix}`, consumers: suffix === '' ? 1 : 0 });
for (const [name, consumers] of [
  ['winwidget.notification.delivery-outcome', 0],
  ['winwidget.notification.delivery-outcome.retry-v2.1', 0],
  ['winwidget.notification.delivery-outcome.retry-v2.2', 0],
  ['winwidget.notification.delivery-outcome.retry-v2.3', 0],
  ['winwidget.notification.delivery-outcome.dead-letter', 0],
]) expectedQueues.push({ name, consumers });
const queue = read(process.env.BILLING_QUEUE_MANIFEST);
if (!exactKeys(queue, ['schemaVersion','action','previousRevision','cleanupRevision',
    'ownershipGeneration','sourceSnapshotSha256','projectionEvidenceSha256',
    'routeEvidenceSha256','rabbitmq','queues','coreState','capturedAt']) ||
    queue.schemaVersion !== 1 || queue.action !== 'billing-core-source-cleanup-queue-drain' ||
    !common(queue) || !isTimestamp(queue.capturedAt) ||
    !exactKeys(queue.rabbitmq, ['containerId','imageId','restartCount','startedAt','vhost']) ||
    !/^[0-9a-f]{64}$/.test(queue.rabbitmq.containerId) || !isImage(queue.rabbitmq.imageId) ||
    !Number.isSafeInteger(queue.rabbitmq.restartCount) || queue.rabbitmq.restartCount < 0 ||
    !isTimestamp(queue.rabbitmq.startedAt) || queue.rabbitmq.vhost !== 'winwidget' ||
    !Array.isArray(queue.queues) || queue.queues.length !== expectedQueues.length ||
    !exactKeys(queue.coreState, ['pendingBillingCompositions','unfinishedLegacyOutboxEvents',
      'activeDeliveryReceipts','unresolvedDeliveryFailures']) ||
    Object.values(queue.coreState).some(value => value !== 0)) process.exit(1);
for (let index = 0; index < expectedQueues.length; index += 1) {
  const item = queue.queues[index];
  const expected = expectedQueues[index];
  if (!exactKeys(item, ['name','ready','unacked','consumers']) || item.name !== expected.name ||
      ![item.ready,item.unacked,item.consumers].every(Number.isSafeInteger) ||
      item.ready !== 0 || item.unacked !== 0 || item.consumers !== 0) process.exit(1);
}
for (const item of writer.services)
  process.stdout.write(`SERVICE\t${item.service}\t${item.containerId}\t${item.imageId}\n`);
process.stdout.write(`RABBIT\t${queue.rabbitmq.containerId}\t${queue.rabbitmq.imageId}\t${queue.rabbitmq.restartCount}\t${queue.rabbitmq.startedAt}\n`);
NODE
	)" || {
		echo 'Billing Core cleanup staged evidence schema or boundary is invalid.' >&2
		return 1
	}
	billing_core_cleanup_writer_manifest_rows="$(awk -F $'\t' '$1 == "SERVICE"' <<<"$output")"
	billing_core_cleanup_broker_manifest="$(awk -F $'\t' '$1 == "RABBIT"' <<<"$output")"
	[[ "$(wc -l <<<"$billing_core_cleanup_writer_manifest_rows" | tr -d ' ')" == \
		"${#billing_core_cleanup_services[@]}" &&
		"$billing_core_cleanup_broker_manifest" == RABBIT$'\t'* ]]
}

billing_core_cleanup_require_broker_identity() {
	local expected_image container_id actual
	expected_image="$(awk -F $'\t' '$1 == "RABBIT" { print $3 }' \
		<<<"$billing_core_cleanup_broker_manifest")"
	[[ "$expected_image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	container_id="$(compose_target ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	actual="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Image}}|{{.State.Running}}' \
		"$container_id" 2>/dev/null || true)"
	[[ "$actual" == "$target_project|rabbitmq|$expected_image|true" ]] || return 1
	docker exec "$container_id" rabbitmqctl --silent list_vhosts name |
		grep -Fqx -- "$rabbitmq_vhost"
}

capture_routine_stop_containers() {
	local service container_id existing_id identity image_id image_revision app_revision state

	routine_stop_container_ids=()
	for service in "${routine_stop_services[@]}"; do
		container_id="$(
			compose_target ps --status running -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" && "$support_first_cutover_deploy" == 'true' ]]; then
			existing_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
			if [[ -z "$existing_id" ]]; then
				[[ "$service" == 'database-restore-worker' ||
					"$service" =~ ^support-(api|worker|outbox-publisher)$ ]] || {
					echo "Support first-cutover lost the stopped $service container identity." >&2
					return 1
				}
				continue
			fi
			[[ "$existing_id" =~ ^[0-9a-f]{64}$ ]] || return 1
			identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$existing_id")" || return 1
			image_id="$(docker inspect --format '{{.Image}}' "$existing_id")" || return 1
			image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" || return 1
			app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$existing_id" | sed -n 's/^APP_REVISION=//p')"
			state="$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' "$existing_id")" || return 1
			[[ "$identity" == "$target_project|$service" &&
				"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
				"$image_revision" =~ ^[0-9a-f]{40}$ &&
				"$app_revision" == "$image_revision" ]] &&
				git -C "$server_root" merge-base --is-ancestor \
					"$image_revision" "$APP_REVISION" || {
				echo "Support first-cutover found an untrusted stopped $service container." >&2
				return 1
			}
			case "$state" in
			'exited|0|false|' | 'exited|143|false|' | 'created|0|false|') ;;
			*)
				echo "Support first-cutover found an unsafe stopped $service state: $state" >&2
				return 1
				;;
			esac
			continue
		fi
		if [[ -z "$container_id" && "$service" == 'database-restore-worker' &&
			-z "$(compose_target ps -a -q "$service" 2>/dev/null || true)" ]]; then
			continue
		fi
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Exactly one running $service is required before the core migration boundary." >&2
			return 1
		fi
		routine_stop_container_ids["$service"]="$container_id"
	done
}

capture_widgets_core_cleanup_precommit_containers() {
	local service container_id identity image_id image_revision app_revision status stopped_state
	local legacy_api_identity expected_legacy_api_identity
	local marker_revision
	local -A candidate_ids=()
	marker_revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	for service in "${routine_stop_services[@]}"; do
		container_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
		if [[ -z "$container_id" && "$service" == 'database-restore-worker' ]]; then
			continue
		fi
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
			echo "Pre-commit Widgets cleanup requires one exact existing container for $service." >&2
			return 1
		}
		identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
		[[ "$identity" == "$target_project|$service" ]] || {
			echo "Pre-commit Widgets cleanup found an untrusted Compose identity for $service." >&2
			return 1
		}
		image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
		image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null | sed -n 's/^APP_REVISION=//p')"
		[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$image_revision" =~ ^[0-9a-f]{40}$ &&
			"$app_revision" == "$image_revision" ]] &&
			git -C "$server_root" cat-file -e "$image_revision^{commit}" 2>/dev/null &&
			git -C "$server_root" merge-base --is-ancestor "$image_revision" "$marker_revision" || {
			echo "Pre-commit Widgets cleanup found an untrusted image revision for $service." >&2
			return 1
		}
		status="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
		case "$status" in
		running) ;;
		exited)
			stopped_state="$(docker inspect --format '{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' "$container_id" 2>/dev/null || true)"
			case "$stopped_state" in
			'0|false|' | '143|false|') ;;
			'137|false|')
				[[ "$service" == 'api' ]] || {
					echo "Pre-commit Widgets cleanup found an unclean stopped state for $service." >&2
					return 1
				}
				legacy_api_identity="$(docker inspect --format \
					'{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
					"$container_id" 2>/dev/null || true)"
				expected_legacy_api_identity="winwidget-api:git-$LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION|$LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID|$LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION|winwidget|api"
				[[ "$legacy_api_identity" == "$expected_legacy_api_identity" ]] || {
					echo 'Pre-commit Widgets cleanup rejected an unpinned API SIGKILL state.' >&2
					return 1
				}
				legacy_api_shutdown_bootstrap_observed=true
				;;
			*)
				echo "Pre-commit Widgets cleanup found an unclean stopped state for $service." >&2
				return 1
				;;
			esac
			;;
		*)
			echo "Pre-commit Widgets cleanup found an unsafe $service state: ${status:-unknown}." >&2
			return 1
			;;
		esac
		candidate_ids["$service"]="$container_id"
	done
	routine_stop_container_ids=()
	for service in "${!candidate_ids[@]}"; do
		routine_stop_container_ids["$service"]="${candidate_ids[$service]}"
	done
}

stop_widgets_core_cleanup_precommit_topology() {
	local service container_id running
	capture_widgets_core_cleanup_precommit_containers || return 1
	for service in "${routine_stop_services[@]}"; do
		container_id="${routine_stop_container_ids[$service]:-}"
		[[ -n "$container_id" ]] || continue
		running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
		if [[ "$running" == 'true' ]]; then
			stop_routine_service_cleanly "$service" 30 || {
				restore_routine_containers_after_failed_stop || true
				return 1
			}
		elif [[ "$running" != 'false' ]]; then
			echo "Pre-commit Widgets cleanup lost the captured state for $service." >&2
			restore_routine_containers_after_failed_stop || true
			return 1
		fi
		if [[ "$service" == 'notification-delivery-worker' &&
			"$reporting_outcome_route_state_before" != 'steady' ]] &&
			! wait_for_reporting_outcome_route_drain; then
			restore_routine_containers_after_failed_stop || true
			return 1
		fi
	done
	if [[ "$mode" == 'production' ]] && ! prepare_database_restore_storage; then
		restore_routine_containers_after_failed_stop || true
		return 1
	fi
	if ! verify_core_database_sessions_drained; then
		restore_routine_containers_after_failed_stop || true
		return 1
	fi
}

detect_interrupted_reporting_outcome_deploy() {
	local route_state="$1"
	local service container_id running status image_id image_revision app_revision identity

	[[ "$route_state" == 'forward' || "$route_state" == 'steady' ]] ||
		return 1
	[[ -e "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]] ||
		return 1
	reporting_cutover_validate_marker >/dev/null 2>&1 || return 1
	[[ "$(reporting_cutover_marker_value phase)" == 'complete' ]] || return 1
	[[ "$(compose_target ps --status running -q rabbitmq 2>/dev/null || true)" =~ ^[0-9a-f]{64}$ ]] ||
		return 1

	for service in "${routine_stop_services[@]}"; do
		container_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
		# Once the source is absent this is a forward-only recovery. A previous
		# interrupted Compose replacement may have removed any one of the old
		# containers already; the remaining deployment recreates every missing
		# canonical service from the pinned cleanup revision.
		if [[ -z "$container_id" ]]; then
			continue
		fi
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
		identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
		[[ "$identity" == "$target_project|$service" ]] || return 1
		image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
		image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null | sed -n 's/^APP_REVISION=//p')"
		[[ "$image_revision" =~ ^[0-9a-f]{40}$ ]] &&
			[[ "$app_revision" == "$image_revision" ]] &&
			git -C "$server_root" cat-file -e "$image_revision^{commit}" 2>/dev/null &&
			git -C "$server_root" merge-base --is-ancestor \
				"$image_revision" "$APP_REVISION" || return 1
		status="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
		if [[ "$service" != 'reporting-service' ]]; then
			running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
			[[ "$running" == 'false' && "$status" == 'exited' ]] || return 1
		else
			[[ "$status" =~ ^(created|running|restarting|exited)$ ]] || return 1
		fi
	done

	echo 'Detected an interrupted forward-only Reporting outcome deployment; canonical stopped containers will be recovered without restoring the legacy route.' >&2
	return 0
}

restore_routine_containers_after_failed_stop() {
	local service
	local container_id
	local running
	local recovery_failed=false
	local attempt
	local all_running
	local restored_reporting_outcome_state

	echo "Restoring the exact pre-migration runtime after an unsafe stop." >&2
	for service in \
		widgets-service \
		reporting-service \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker \
		campaigns-service \
		api \
		api-gateway; do
		container_id="${routine_stop_container_ids[$service]:-}"
		if [[ -z "$container_id" ]]; then
			continue
		fi
		running="$(
			docker inspect --format '{{.State.Running}}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" == "true" ]]; then
			continue
		fi
		if [[ "$running" != "false" ]]; then
			echo "Could not restart exact pre-migration container: $service" >&2
			recovery_failed=true
			continue
		fi
		if [[ "$service" == integration-worker ]] &&
			! routine_require_platform_admin_audit_topology; then
			echo 'Platform admin-audit topology is unsafe; integration-worker recovery remains stopped.' >&2
			recovery_failed=true
			continue
		fi
		if ! docker start "$container_id" >/dev/null; then
			echo "Could not restart exact pre-migration container: $service" >&2
			recovery_failed=true
		fi
	done

	if [[ "$recovery_failed" == "true" ]]; then
		echo "CRITICAL: the exact pre-migration runtime could not be restored completely." >&2
		return 1
	fi

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		all_running=true
		for service in "${routine_stop_services[@]}"; do
			container_id="${routine_stop_container_ids[$service]:-}"
			if [[ -z "$container_id" ]]; then
				continue
			fi
			running="$(
				docker inspect --format '{{.State.Running}}' \
					"$container_id" 2>/dev/null || true
			)"
			if [[ "$running" != "true" ]]; then
				all_running=false
				break
			fi
		done
		if [[ "$all_running" == "true" ]] &&
			{ [[ -z "${routine_stop_container_ids[api]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[api-gateway]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$GATEWAY_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[maintenance-worker]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$MAINTENANCE_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[notification-delivery-worker]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$NOTIFICATION_DELIVERY_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[campaigns-service]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$CAMPAIGNS_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[reporting-service]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$REPORTING_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[widgets-service]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$WIDGETS_READINESS_URL" >/dev/null; }; then
			if [[ -n "${routine_stop_container_ids[reporting-service]:-}" ]]; then
				if [[ "$reporting_outcome_route_state_before" == 'steady' ]]; then
					reporting_require_rabbitmq_topology || {
						echo 'Restored Reporting runtime did not recreate the steady topology.' >&2
						return 1
					}
				else
					restored_reporting_outcome_state="$(
						reporting_outcome_route_topology_state
					)"
					[[ "$restored_reporting_outcome_state" == 'legacy' ||
						"$restored_reporting_outcome_state" == 'dual' ]] || {
						echo 'Restored Reporting runtime did not recreate the legacy outcome route.' >&2
						return 1
					}
				fi
			fi
			echo "Exact containers which were running at entry were restored; no Core cleanup migration was executed." >&2
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "CRITICAL: the exact pre-migration runtime restarted but did not become healthy." >&2
	return 1
}

stop_routine_service_cleanly() {
	local service="$1"
	local timeout="$2"
	local container_id
	local stopped_state
	local legacy_api_identity
	local expected_legacy_api_identity

	container_id="${routine_stop_container_ids[$service]:-}"
	if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
		echo "Captured container ID is invalid for $service." >&2
		return 1
	fi
	if ! docker stop --time "$timeout" "$container_id" >/dev/null; then
		echo "Could not stop $service before the core migration boundary." >&2
		return 1
	fi
	stopped_state="$(
		docker inspect --format \
			'{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' \
			"$container_id" 2>/dev/null || true
	)"
	case "$stopped_state" in
	"exited|0|false|" | "exited|143|false|")
		return 0
		;;
	esac
	if [[ "$service" == "api" && "$stopped_state" == "exited|137|false|" ]]; then
		legacy_api_identity="$(
			docker inspect --format \
				'{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
				"$container_id" 2>/dev/null || true
		)"
		expected_legacy_api_identity="winwidget-api:git-$LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION|$LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID|$LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION|winwidget|api"
		if [[ "$legacy_api_identity" == "$expected_legacy_api_identity" ]]; then
			legacy_api_shutdown_bootstrap_observed=true
			echo "Known legacy API image required SIGKILL; continuing only to the zero-session core database boundary." >&2
			return 0
		fi
	fi

	echo "$service did not stop cleanly: ${stopped_state:-unavailable}" >&2
	return 1
}

verify_core_database_sessions_drained() {
	local session_count

	if ! session_count="$(
		docker run --rm --network host \
			--env-file "$ENV_FILE" \
			--entrypoint node \
			"winwidget-api:$APP_VERSION" \
			-e '
const { PrismaClient } = require("@prisma/client");
const url = process.env.DATABASE_MIGRATION_URL_PRODUCTION;
if (!url) throw new Error("Core migration URL is missing");
const prisma = new PrismaClient({ datasources: { db: { url } } });
prisma.$queryRawUnsafe(
  `SELECT COUNT(*)::int AS count
   FROM pg_stat_activity
   WHERE datname = current_database()
     AND backend_type = $type$client backend$type$
     AND pid <> pg_backend_pid()`,
).then(rows => {
  process.stdout.write(String(rows[0]?.count ?? "invalid"));
}).finally(() => prisma.$disconnect());
'
	)"; then
		echo "Could not verify drained core PostgreSQL sessions." >&2
		return 1
	fi
	if [[ "$session_count" != "0" ]]; then
		echo "Core PostgreSQL still has $session_count other session(s); migration is blocked." >&2
		return 1
	fi

	if [[ "$legacy_api_shutdown_bootstrap_observed" == "true" ]]; then
		echo "Legacy API bootstrap accepted only after all other core sessions drained." >&2
	fi
	echo "Core PostgreSQL sessions drained."
}

billing_core_cleanup_require_live_database_boundary() {
	local require_drain="${1:-true}" state expected_revision expected_core_system
	local expected_billing_system expected_billing_database billing_container_id
	local billing_admin_password_file billing_admin_password billing_identity
	local core_state_count unresolved_failures active_receipts unfinished_outbox
	local pending_compositions core_system prepared_revision ownership_revision
	local billing_system billing_database service_phase service_generation
	local ownership_phase ownership_generation billing_prepared_revision
	local billing_ownership_revision billing_cleanup_revision pending_outbox
	local provider_operations active_sessions
	[[ "$require_drain" == 'true' || "$require_drain" == 'false' ]] || return 1
	expected_revision="$(billing_core_source_cleanup_marker_value previous_revision)" || return 1
	expected_core_system="$(billing_core_source_cleanup_marker_value core_system_identifier)" || return 1
	expected_billing_system="$(billing_core_source_cleanup_marker_value billing_system_identifier)" || return 1
	expected_billing_database="$(billing_core_source_cleanup_marker_value billing_database_id)" || return 1
	state="$(billing_core_database_query '
SELECT
  (
    SELECT COUNT(*)
    FROM public.billing_core_state
    WHERE id = $state$singleton$state$
      AND ownership = $state$BILLING$state$::public."BillingCoreOwnership"
      AND NOT source_producers_enabled
      AND NOT legacy_routes_enabled
      AND NOT scheduler_enabled
      AND NOT legacy_consumer_enabled
      AND projection_consumer_enabled
      AND generation = 2
  ) || CHR(9) ||
  (
    SELECT COUNT(*)
    FROM public.integration_delivery_failures
    WHERE integration IN ($state$auto-renewal$state$, $state$notification-delivery-outcome$state$)
      AND resolved_at IS NULL
  ) || CHR(9) ||
  (
    SELECT COUNT(*)
    FROM public.integration_delivery_receipts
    WHERE integration IN ($state$auto-renewal$state$, $state$notification-delivery-outcome$state$)
      AND status::TEXT IN ($state$PROCESSING$state$, $state$RETRY_SCHEDULED$state$)
  ) || CHR(9) ||
  (
    SELECT COUNT(*)
    FROM public.outbox_events
    WHERE event_type IN (
      $state$billing.settings.source.changed.v1$state$,
      $state$billing.payment.changed.v1$state$,
      $state$billing.subscription.changed.v1$state$,
      $state$notification.subscription-expiry.email.requested.v1$state$,
      $state$notification.subscription-expiry.telegram.requested.v1$state$,
      $state$payment.auto-renewal.charge.requested.v1$state$,
      $state$payment.notification.telegram.requested.v1$state$,
      $state$payment.succeeded.v1$state$
    )
      AND status::TEXT <> $state$PUBLISHED$state$
  ) || CHR(9) ||
  (
    SELECT COUNT(*)
    FROM public.billing_settings_compositions
    WHERE status::TEXT IN ($state$PENDING$state$, $state$BILLING_APPLIED$state$)
  ) || CHR(9) ||
  (SELECT system_identifier FROM pg_control_system()) || CHR(9) ||
  COALESCE((SELECT prepared_revision FROM public.billing_core_state WHERE id = $state$singleton$state$), $state$$state$) || CHR(9) ||
  COALESCE((SELECT ownership_revision FROM public.billing_core_state WHERE id = $state$singleton$state$), $state$$state$);
')" || {
		echo 'Could not verify the stopped Billing Core database boundary.' >&2
		return 1
	}
	IFS=$'\t' read -r core_state_count unresolved_failures active_receipts \
		unfinished_outbox pending_compositions core_system prepared_revision \
		ownership_revision <<<"$state"
	[[ "$core_state_count" == '1' && "$core_system" == "$expected_core_system" &&
		"$prepared_revision" == "$expected_revision" &&
		"$ownership_revision" == "$expected_revision" &&
		"$unresolved_failures" =~ ^[0-9]+$ && "$active_receipts" =~ ^[0-9]+$ &&
		"$unfinished_outbox" =~ ^[0-9]+$ && "$pending_compositions" =~ ^[0-9]+$ ]] || {
		echo 'Billing Core database identity or ownership boundary changed.' >&2
		return 1
	}
	if [[ "$require_drain" == 'true' &&
		( "$unresolved_failures" != '0' || "$active_receipts" != '0' ||
			"$unfinished_outbox" != '0' || "$pending_compositions" != '0' ) ]]; then
		echo 'Billing Core durable work is not drained at the pre-commit boundary.' >&2
		return 1
	fi
	billing_container_id="$(compose_target ps --status running -q billing-postgres 2>/dev/null || true)"
	[[ "$billing_container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	billing_admin_password_file="$(get_env_value BILLING_POSTGRES_ADMIN_PASSWORD_FILE)" || return 1
	billing_admin_password="$(tr -d '\r\n' <"$billing_admin_password_file")"
	billing_identity="$(docker exec -e "PGPASSWORD=$billing_admin_password" "$billing_container_id" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 --quiet \
		--tuples-only --no-align --field-separator='|' \
		--username winwidget_billing_admin --dbname winwidget_billing --command \
		"SELECT (SELECT system_identifier FROM pg_control_system()), identity.database_id::TEXT, identity.phase::TEXT, identity.ownership_generation::TEXT, ownership.phase::TEXT, ownership.generation::TEXT, ownership.prepared_revision, ownership.ownership_revision, ownership.cleanup_revision, (SELECT COUNT(*) FROM billing.outbox_events WHERE status::TEXT <> 'PUBLISHED'), (SELECT COUNT(*) FROM billing.provider_operations WHERE status::TEXT IN ('PROCESSING','UNKNOWN')), (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()) FROM billing.service_identity AS identity CROSS JOIN billing.billing_ownership_marker AS ownership WHERE identity.id = 'singleton' AND identity.service_name = 'billing-service' AND ownership.id = 'singleton';" 2>/dev/null)" || {
		unset billing_admin_password
		return 1
	}
	unset billing_admin_password
	IFS='|' read -r billing_system billing_database service_phase service_generation \
		ownership_phase ownership_generation billing_prepared_revision \
		billing_ownership_revision billing_cleanup_revision pending_outbox \
		provider_operations active_sessions <<<"$billing_identity"
	[[ "$billing_system" == "$expected_billing_system" &&
		"$billing_database" == "$expected_billing_database" &&
		"$service_phase" == 'ACTIVE' && "$service_generation" == '2' &&
		"$ownership_phase" == 'COMPLETE' && "$ownership_generation" == '2' &&
		"$billing_prepared_revision" == "$expected_revision" &&
		"$billing_ownership_revision" == "$expected_revision" &&
		"$billing_cleanup_revision" == "$expected_revision" &&
		"$pending_outbox" =~ ^[0-9]+$ && "$provider_operations" =~ ^[0-9]+$ &&
		"$active_sessions" == '0' ]] || {
		echo 'Billing database identity, ownership or stopped-session boundary changed.' >&2
		return 1
	}
	if [[ "$require_drain" == 'true' &&
		( "$pending_outbox" != '0' || "$provider_operations" != '0' ) ]]; then
		echo 'Billing durable work is not drained at the pre-commit boundary.' >&2
		return 1
	fi
}

billing_core_cleanup_queue_state() {
	local rabbitmq_container_id
	if [[ "$billing_core_cleanup_require_staged_broker" == 'true' &&
		-n "$billing_core_cleanup_broker_manifest" ]]; then
		billing_core_cleanup_require_broker_identity || {
			echo 'RabbitMQ identity changed after Billing cleanup evidence was sealed.' >&2
			return 1
		}
	fi
	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq 2>/dev/null || true
	)"
	[[ "$rabbitmq_container_id" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Billing Core cleanup requires one running canonical RabbitMQ container.' >&2
		return 1
	}
	docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
		list_queues -p "$rabbitmq_vhost" \
		name messages_ready messages_unacknowledged consumers
}

billing_core_cleanup_require_stopped_queue_boundary() {
	local allow_retired_absent="${1:-false}" state
	[[ "$allow_retired_absent" == 'true' || "$allow_retired_absent" == 'false' ]] ||
		return 1
	state="$(billing_core_cleanup_queue_state)" || return 1
	BILLING_ALLOW_RETIRED_ABSENT="$allow_retired_absent" billing_release_node_stdin -e '
const fs = require("node:fs");
const rows = fs.readFileSync(0, "utf8").trim().split(/\n/).filter(Boolean)
  .map(line => line.trim().split(/\s+/));
const queues = new Map();
for (const row of rows) {
  if (row.length !== 4 || queues.has(row[0])) process.exit(1);
  const values = row.slice(1).map(Number);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) process.exit(1);
  queues.set(row[0], values);
}
const retained = [
  "winwidget.billing.identity.v1",
  "winwidget.billing.offer.v1",
  "winwidget.billing.notification-routing.v1",
  "winwidget.billing.settings-source.v1",
  "winwidget.billing.trial.v1",
  "winwidget.billing.referral.v1",
  "winwidget.billing.lifecycle-repair.v1",
  "winwidget.payment.auto-renewal",
  "winwidget.billing.notification-delivery-outcome",
];
const retainedSuffixes = ["", ".retry.1", ".retry.2", ".retry.3", ".dead-letter"];
for (const base of retained) for (const suffix of retainedSuffixes) {
  const values = queues.get(`${base}${suffix}`);
  if (!values) process.exit(1);
  if (process.env.BILLING_ALLOW_RETIRED_ABSENT === "true") {
    if (values[2] !== 0) process.exit(1);
  } else if (values.some(value => value !== 0)) process.exit(1);
}
const retired = [
  "winwidget.notification.delivery-outcome",
  "winwidget.notification.delivery-outcome.retry-v2.1",
  "winwidget.notification.delivery-outcome.retry-v2.2",
  "winwidget.notification.delivery-outcome.retry-v2.3",
  "winwidget.notification.delivery-outcome.dead-letter",
];
const present = retired.filter(name => queues.has(name));
if (process.env.BILLING_ALLOW_RETIRED_ABSENT !== "true" && present.length !== retired.length)
  process.exit(1);
for (const name of present) if (queues.get(name).some(value => value !== 0)) process.exit(1);
process.stdout.write(present.length === 0 ? "absent" :
  present.length === retired.length ? "present" : "partial");
' <<<"$state"
}

billing_core_cleanup_delete_retired_outcome_queues() {
	local rabbitmq_container_id retired_state queue
	retired_state="$(billing_core_cleanup_require_stopped_queue_boundary true)" || return 1
	if [[ "$retired_state" == 'absent' ]]; then
		echo 'Legacy Core notification outcome queue family is already absent.'
		return 0
	fi
	rabbitmq_container_id="$(compose_target ps --status running -q rabbitmq)"
	for queue in \
		winwidget.notification.delivery-outcome.retry-v2.1 \
		winwidget.notification.delivery-outcome.retry-v2.2 \
		winwidget.notification.delivery-outcome.retry-v2.3 \
		winwidget.notification.delivery-outcome.dead-letter \
		winwidget.notification.delivery-outcome; do
		if billing_core_cleanup_queue_state | awk -v expected="$queue" \
			'$1 == expected { found = 1 } END { exit(found ? 0 : 1) }'; then
			docker exec "$rabbitmq_container_id" rabbitmqctl delete_queue \
				-p "$rabbitmq_vhost" "$queue" --if-empty --if-unused >/dev/null || return 1
		fi
	done
	[[ "$(billing_core_cleanup_require_stopped_queue_boundary true)" == 'absent' ]] ||
		return 1
	echo 'Legacy Core notification outcome queue family was retired at the forward-only boundary.'
}

billing_core_cleanup_require_retired_outcome_absent() {
	local rabbitmq_container_id state bindings queue
	rabbitmq_container_id="$(compose_target ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ "$rabbitmq_container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	state="$(billing_core_cleanup_queue_state)" || return 1
	for queue in \
		winwidget.notification.delivery-outcome \
		winwidget.notification.delivery-outcome.retry-v2.1 \
		winwidget.notification.delivery-outcome.retry-v2.2 \
		winwidget.notification.delivery-outcome.retry-v2.3 \
		winwidget.notification.delivery-outcome.dead-letter; do
		if awk -v expected="$queue" \
			'$1 == expected { found = 1 } END { exit(found ? 0 : 1) }' \
			<<<"$state"; then
			return 1
		fi
	done
	bindings="$(docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
		list_bindings -p "$rabbitmq_vhost" destination_name)" || return 1
	for queue in \
		winwidget.notification.delivery-outcome \
		winwidget.notification.delivery-outcome.retry-v2.1 \
		winwidget.notification.delivery-outcome.retry-v2.2 \
		winwidget.notification.delivery-outcome.retry-v2.3 \
		winwidget.notification.delivery-outcome.dead-letter; do
		if awk -v expected="$queue" \
			'$1 == expected { found = 1 } END { exit(found ? 0 : 1) }' \
			<<<"$bindings"; then
			return 1
		fi
	done
}

billing_core_cleanup_capture_precommit_containers() {
	local service container_id identity image_id image_revision app_revision state expected
	local record_type expected_service expected_container_id expected_image_id
	local previous_revision
	previous_revision="$(billing_core_source_cleanup_marker_value previous_revision)" || return 1
	routine_stop_container_ids=()
	for service in "${billing_core_cleanup_services[@]}"; do
		container_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
			echo "Pre-commit Billing cleanup requires one staged stopped $service container." >&2
			return 1
		}
		identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
		image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
		image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null | sed -n 's/^APP_REVISION=//p')"
		state="$(docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}|{{.RestartCount}}' "$container_id" 2>/dev/null || true)"
		expected="$(awk -F $'\t' -v service="$service" \
			'$1 == "SERVICE" && $2 == service { print; found += 1 } END { exit(found == 1 ? 0 : 1) }' \
			<<<"$billing_core_cleanup_writer_manifest_rows")" || return 1
		IFS=$'\t' read -r record_type expected_service expected_container_id expected_image_id \
			<<<"$expected"
		[[ "$identity" == "$target_project|$service" &&
			"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$record_type" == 'SERVICE' && "$expected_service" == "$service" &&
			"$container_id" == "$expected_container_id" &&
			"$image_id" == "$expected_image_id" &&
			"$image_revision" == "$previous_revision" &&
			"$app_revision" == "$previous_revision" &&
			( "$state" == 'exited|false|0|false||0' ||
				"$state" == 'exited|false|143|false||0' ) ]] || {
			echo "Pre-commit Billing cleanup found an untrusted runtime identity for $service." >&2
			return 1
		}
		routine_stop_container_ids["$service"]="$container_id"
	done
}

billing_core_cleanup_adopt_forward_containers() {
	local service container_id identity image_id image_revision app_revision status running
	local previous_revision cleanup_revision
	previous_revision="$(billing_core_source_cleanup_marker_value previous_revision)" || return 1
	cleanup_revision="$(billing_core_source_cleanup_marker_value revision)" || return 1
	routine_stop_container_ids=()
	for service in "${billing_core_cleanup_services[@]}"; do
		container_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
		[[ -n "$container_id" ]] || continue
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
		identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
		image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
		image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null | sed -n 's/^APP_REVISION=//p')"
		[[ "$identity" == "$target_project|$service" &&
			"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			( "$image_revision" == "$previous_revision" || "$image_revision" == "$cleanup_revision" ) &&
			"$app_revision" == "$image_revision" ]] || {
			echo "Forward Billing cleanup found an untrusted runtime identity for $service." >&2
			return 1
		}
		status="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
		running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
		case "$status|$running" in
		running\|true | restarting\|true)
			routine_stop_container_ids["$service"]="$container_id"
			stop_routine_service_cleanly "$service" 30 || return 1
			;;
		created\|false | exited\|false) ;;
		*)
			echo "Forward Billing cleanup found an unsafe state for $service: $status." >&2
			return 1
			;;
		esac
	done
}

stop_billing_core_cleanup_topology() {
	local source_state service
	source_state="$(billing_core_source_state)" || return 1
	if [[ "$source_state" == 'present' ]]; then
		billing_core_cleanup_capture_precommit_containers || return 1
	else
		[[ "$source_state" == 'absent' ]] || return 1
		billing_core_cleanup_adopt_forward_containers || return 1
	fi
	if [[ "$mode" == 'production' ]]; then
		prepare_database_restore_storage || return 1
	fi
	verify_core_database_sessions_drained || return 1
	if [[ "$source_state" == 'present' ]]; then
		billing_core_cleanup_require_live_database_boundary true || return 1
	else
		billing_core_cleanup_require_live_database_boundary false || return 1
	fi
	if [[ "$source_state" == 'present' ]]; then
		[[ "$(billing_core_cleanup_require_stopped_queue_boundary false)" == 'present' ]] ||
			return 1
	else
		billing_core_cleanup_require_stopped_queue_boundary true >/dev/null || return 1
	fi
}

recover_billing_core_cleanup_stop_on_exit() {
	local status=$? source_state migration_state
	trap - EXIT INT TERM
	[[ "$billing_core_cleanup_stop_recovery_active" == 'true' ]] || exit "$status"
	set +e
	source_state="$(billing_core_source_state 2>/dev/null || printf 'unknown')"
	migration_state="$(billing_core_source_cleanup_migration_state 2>/dev/null || printf 'unsafe')"
	if [[ "$source_state" == 'present' &&
		"$migration_state" =~ ^(pending|rolled-back|unfinished)$ ]]; then
		echo 'Billing Core cleanup did not commit; sealed SHA A writers remain stopped for an exact retry.' >&2
	elif [[ "$source_state" == 'absent' ]]; then
		echo 'Billing Core source is absent; old writers remain stopped and recovery is forward-only.' >&2
	else
		echo 'Billing Core cleanup state is ambiguous; all writers remain stopped.' >&2
	fi
	exit "$status"
}

stop_routine_topology_for_core_migration() {
	local service

	capture_routine_stop_containers || return 1
	for service in "${routine_stop_services[@]}"; do
		if [[ -z "${routine_stop_container_ids[$service]:-}" &&
			( "$service" == 'database-restore-worker' ||
				"$support_first_cutover_deploy" == 'true' ) ]]; then
			continue
		fi
		if stop_routine_service_cleanly "$service" 30; then
			if [[ "$service" == 'notification-delivery-worker' &&
				"$reporting_outcome_route_state_before" != 'steady' ]] &&
				! wait_for_reporting_outcome_route_drain; then
				restore_routine_containers_after_failed_stop || true
				return 1
			fi
			continue
		fi
		restore_routine_containers_after_failed_stop || true
		return 1
	done
	if [[ "$mode" == 'production' ]]; then
		if ! prepare_database_restore_storage; then
			restore_routine_containers_after_failed_stop || true
			return 1
		fi
	fi
	if ! verify_core_database_sessions_drained; then
		restore_routine_containers_after_failed_stop || true
		return 1
	fi
}

widgets_core_cleanup_revalidate_boundary() {
	local marker_revision marker_previous marker_generation marker_fingerprint marker_snapshot
	local identity_generation identity_fingerprint identity_snapshot identity_database_id
	local marker_database_id source_state migration_state verification_image_id verification_revision
	widgets_core_source_cleanup_validate_marker || {
		echo 'Widgets Core source cleanup marker changed or became invalid.' >&2
		return 1
	}
	marker_revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	marker_previous="$(widgets_core_source_cleanup_marker_value previous_revision)" || return 1
	[[ "$marker_revision" == "$APP_REVISION" && "$marker_previous" != "$marker_revision" ]] || return 1
	git -C "$server_root" merge-base --is-ancestor "$marker_previous" "$marker_revision" || {
		echo 'Widgets Core source cleanup revision is not a forward descendant of the staged runtime.' >&2
		return 1
	}
	widgets_core_source_cleanup_require_staged_evidence || {
		echo 'Widgets Core source cleanup dump or restore evidence changed after staging.' >&2
		return 1
	}
	IFS=$'\t' read -r identity_generation identity_fingerprint identity_snapshot identity_database_id \
		<<<"$(widgets_service_identity_cleanup_evidence)" || return 1
	marker_generation="$(widgets_core_source_cleanup_marker_value ownership_generation)"
	marker_fingerprint="$(widgets_core_source_cleanup_marker_value source_database_fingerprint)"
	marker_snapshot="$(widgets_core_source_cleanup_marker_value source_snapshot_sha256)"
	marker_database_id="$(widgets_core_source_cleanup_marker_value widgets_database_id)"
	[[ "$identity_generation" == "$marker_generation" &&
		"$identity_fingerprint" == "$marker_fingerprint" &&
		"$identity_snapshot" == "$marker_snapshot" &&
		"$identity_database_id" == "$marker_database_id" ]] || {
		echo 'Widgets ownership evidence changed after Core source cleanup staging.' >&2
		return 1
	}
	source_state="$(widgets_core_source_state)" || return 1
	migration_state="$(widgets_core_source_cleanup_migration_state)" || return 1
	case "$source_state|$migration_state" in
	present\|pending | present\|rolled-back | present\|unfinished | \
		absent\|unfinished | absent\|applied) ;;
	*)
		echo "Widgets Core source cleanup boundary is unsafe: source=$source_state migration=$migration_state." >&2
		return 1
		;;
	esac
	if [[ "$source_state" == 'present' ]]; then
		verification_image_id="$(docker image inspect --format '{{.Id}}' "$MAINTENANCE_IMAGE" 2>/dev/null)" || return 1
		verification_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$verification_image_id" 2>/dev/null)" ||
			return 1
		[[ "$verification_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$verification_revision" == "$APP_REVISION" ]] || {
			echo 'Widgets Core cleanup parity check requires the pinned maintenance image.' >&2
			return 1
		}
		widgets_core_source_ids_and_counts_are_covered "$verification_image_id" || {
			echo 'Legacy Widgets source counts or target ID coverage changed after staging.' >&2
			return 1
		}
	fi
}

widgets_core_cleanup_migration_url() {
	local generation snapshot core_backup widgets_backup restore_evidence migration_url
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	snapshot="$(widgets_core_source_cleanup_marker_value source_snapshot_sha256)" || return 1
	core_backup="$(widgets_core_source_cleanup_marker_value core_backup_sha256)" || return 1
	widgets_backup="$(widgets_core_source_cleanup_marker_value widgets_backup_sha256)" || return 1
	restore_evidence="$(widgets_core_source_cleanup_marker_value restore_evidence_sha256)" || return 1
	migration_url="$(widgets_core_source_cleanup_migration_url_from_env \
		"$generation" "$snapshot" "$core_backup" "$widgets_backup" "$restore_evidence")" || {
		echo 'Widgets Core cleanup could not derive the exact migration URL from the production env.' >&2
		return 1
	}
	printf '%s' "$migration_url"
}

stop_widgets_core_cleanup_topology_for_recovery() {
	local service container_id identity status running image_id image_revision
	routine_stop_container_ids=()
	for service in "${routine_stop_services[@]}"; do
		container_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
		if [[ -z "$container_id" ]]; then
			continue
		fi
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
			echo "Widgets Core cleanup recovery requires one exact container for $service." >&2
			return 1
		}
		identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
		[[ "$identity" == "$target_project|$service" ]] || return 1
		image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
		image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
		[[ "$image_revision" =~ ^[0-9a-f]{40}$ ]] &&
			git -C "$server_root" merge-base --is-ancestor "$image_revision" "$APP_REVISION" || {
			echo "Widgets Core cleanup found an untrusted $service image." >&2
			return 1
		}
		routine_stop_container_ids["$service"]="$container_id"
		status="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
		running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
		if [[ "$running" == 'true' ]]; then
			stop_routine_service_cleanly "$service" 30 || return 1
		elif [[ "$running" != 'false' || ! "$status" =~ ^(created|exited)$ ]]; then
			echo "Widgets Core cleanup found an unsafe $service state: ${status:-unknown}." >&2
			return 1
		fi
	done
	prepare_database_restore_storage || return 1
	verify_core_database_sessions_drained
}

recover_widgets_core_cleanup_stop_on_exit() {
	local source_state migration_state
	trap - EXIT INT TERM
	[[ "$widgets_core_cleanup_stop_recovery_active" == 'true' ]] || return
	source_state="$(widgets_core_source_state 2>/dev/null || printf 'unknown')"
	migration_state="$(widgets_core_source_cleanup_migration_state 2>/dev/null || printf 'unsafe')"
	if [[ "$source_state" == 'present' &&
		"$migration_state" =~ ^(pending|rolled-back|unfinished)$ ]]; then
		echo 'Widgets Core source cleanup did not commit; restoring the exact pre-migration runtime.' >&2
		restore_routine_containers_after_failed_stop || true
	elif [[ "$source_state" == 'absent' ]]; then
		echo 'Widgets Core source is already absent; old writers will not be restored. Resume the exact cleanup revision forward.' >&2
	else
		echo "Widgets Core source cleanup recovery is ambiguous: source=$source_state migration=$migration_state; writers remain stopped." >&2
	fi
}

stop_reporting_cleanup_topology_for_core_migration() {
	local migration_state="$1" previous_revision service container_id
	local container_state image_id image_revision identity compose_project compose_service
	local -a cleanup_services=("${routine_stop_services[@]}")

	[[ "$migration_state" == 'pending' || "$migration_state" == 'applied' ]] || return 1
	previous_revision="$(reporting_cutover_marker_value revision)" || return 1
	routine_stop_container_ids=()
	for service in "${cleanup_services[@]}"; do
		container_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
		if [[ -z "$container_id" ]]; then
			if [[ "$service" == 'database-restore-worker' ||
				( "$service" == 'reporting-service' && "$migration_state" == 'applied' ) ]]; then
				continue
			fi
			echo "Reporting cleanup recovery requires one exact existing container for $service." >&2
			return 1
		fi
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
			echo "Reporting cleanup container identity is ambiguous for $service." >&2
			return 1
		}
		identity="$(docker inspect --format \
			'{{.State.Status}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
			"$container_id" 2>/dev/null || true)"
		IFS='|' read -r container_state image_id compose_project compose_service <<<"$identity"
		[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$compose_project" == "$target_project" && "$compose_service" == "$service" ]] || {
			echo "Reporting cleanup found an untrusted container identity for $service." >&2
			return 1
		}
		image_revision="$(docker image inspect --format \
			'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$image_id" 2>/dev/null || true)"
		if [[ ! "$image_revision" =~ ^[0-9a-f]{40}$ ]] ||
			! git -C "$server_root" cat-file -e \
				"$image_revision^{commit}" 2>/dev/null ||
			! git -C "$server_root" merge-base --is-ancestor \
				"$image_revision" "$APP_REVISION"; then
			echo "Reporting cleanup found an unknown or divergent image for $service." >&2
			return 1
		fi
		if [[ "$migration_state" == 'pending' ]]; then
			[[ "$image_revision" != "$APP_REVISION" &&
				( "$service" != 'reporting-service' || "$image_revision" == "$previous_revision" ) ]] || {
				echo "Pending Reporting cleanup found a non-rollback image for $service." >&2
				return 1
			}
		elif [[ "$service" == 'reporting-service' ]]; then
			[[ "$image_revision" == "$previous_revision" ||
				"$image_revision" == "$APP_REVISION" ]] || {
				echo 'Applied cleanup found a Reporting image outside the pinned old/new boundary.' >&2
				return 1
			}
		fi
		case "$container_state" in
		running | restarting)
			routine_stop_container_ids["$service"]="$container_id"
			stop_routine_service_cleanly "$service" 30 || return 1
			;;
		exited)
			;;
		created)
			[[ "$migration_state" == 'applied' && "$image_revision" == "$APP_REVISION" ]] || {
				echo "Pending cleanup cannot trust a merely created container for $service." >&2
				return 1
			}
			;;
		*)
			echo "Reporting cleanup found an unsafe container state for $service: ${container_state:-unknown}." >&2
			return 1
			;;
		esac
	done
	if [[ "$mode" == 'production' ]]; then
		prepare_database_restore_storage || return 1
	fi
	verify_core_database_sessions_drained
}

recover_reporting_cleanup_stop_on_exit() {
	local status=$? current_state='unsafe'
	trap - EXIT INT TERM
	if [[ "$reporting_cleanup_stop_recovery_active" != 'true' ]]; then
		exit "$status"
	fi
	set +e
	current_state="$(reporting_cutover_core_cleanup_migration_state "$APP_REVISION" 2>/dev/null)"
	case "$current_state" in
	pending)
		echo 'Reporting cleanup stopped before the destructive migration committed; restoring only the exact containers which were running at entry.' >&2
		restore_routine_containers_after_failed_stop || true
		;;
	applied)
		echo 'Reporting cleanup migration is applied; old Core writers will not be restored. Retry the exact cleanup revision to continue forward.' >&2
		;;
	*)
		echo 'Reporting cleanup migration state is ambiguous; all Core writers remain stopped for reviewed recovery.' >&2
		;;
	esac
	exit "$status"
}

notification_cutover_container_id() {
	local service="$1"
	local container_id

	container_id="$(
		compose_notification_cutover ps -a -q "$service" 2>/dev/null || true
	)"
	if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
		echo "Saved forward cutover service does not have exactly one container: $service" >&2
		return 1
	fi
	printf '%s\n' "$container_id"
}

verify_saved_notification_cutover_containers() {
	local expected_revision="$1"
	local service
	local container_id
	local image_revision
	local restart_count

	for service in "${notification_cutover_candidate_services[@]}"; do
		container_id="$(
			notification_cutover_container_id "$service"
		)" || return 1
		image_revision="$(
			docker inspect \
				--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$image_revision" != "$expected_revision" ]]; then
			echo "Saved forward cutover service has an unexpected image revision: $service" >&2
			return 1
		fi
		restart_count="$(
			docker inspect --format '{{ .RestartCount }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$restart_count" != "0" ]]; then
			echo "Saved forward cutover service restarted before recovery: $service restartCount=${restart_count:-unknown}" >&2
			return 1
		fi
	done
}

start_notification_cutover_services() {
	local service
	local container_id
	local running

	for service in "$@"; do
		container_id="$(
			notification_cutover_container_id "$service"
		)" || return 1
		running="$(
			docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" == "true" ]]; then
			continue
		fi
		if [[ "$running" != "false" ]]; then
			echo "Saved forward cutover service has an unreadable state: $service" >&2
			return 1
		fi
		if [[ "$service" == integration-worker ]]; then
			routine_require_platform_admin_audit_topology || return 1
		fi
		if ! docker start "$container_id" >/dev/null; then
			echo "Saved forward cutover service could not be started: $service" >&2
			return 1
		fi
	done
}

stop_notification_cutover_services() {
	local timeout="$1"
	local allow_missing="$2"
	shift 2
	local service
	local container_id
	local running

	for service in "$@"; do
		container_id="$(
			compose_notification_cutover ps -a -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" && "$allow_missing" == "true" ]]; then
			continue
		fi
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Saved forward cutover service does not have exactly one container: $service" >&2
			return 1
		fi
		running="$(
			docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" == "false" ]]; then
			continue
		fi
		if [[ "$running" != "true" ]]; then
			echo "Saved forward cutover service has an unreadable state: $service" >&2
			return 1
		fi
		if ! docker stop --timeout "$timeout" "$container_id" >/dev/null; then
			echo "Saved forward cutover service could not be stopped: $service" >&2
			return 1
		fi
	done
}

remove_notification_cutover_services() {
	local service
	local container_id
	local running
	local container_ids=()

	for service in "$@"; do
		container_id="$(
			compose_notification_cutover ps -a -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" ]]; then
			continue
		fi
		if [[ "$container_id" == *$'\n'* ]]; then
			echo "Saved forward cutover service has multiple containers: $service" >&2
			return 1
		fi
		running="$(
			docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" != "false" ]]; then
			echo "Saved forward cutover service must be stopped before removal: $service" >&2
			return 1
		fi
		container_ids+=("$container_id")
	done

	if [[ ${#container_ids[@]} -gt 0 ]]; then
		docker rm "${container_ids[@]}" >/dev/null
	fi
}

verify_notification_delivery_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$NOTIFICATION_DELIVERY_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/main.js",
	"prisma/schema.prisma",
	"assets/email-logo.png",
]) {
	fs.accessSync(required);
}
require("@prisma/notification-delivery-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/messaging/notification-delivery-client.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(
			`Notification Delivery image contains monolith artifact: ${forbidden}`,
		);
	}
}
process.stdout.write("Standalone Notification Delivery image artifact verified\n");
	'
}

verify_campaigns_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$CAMPAIGNS_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of ["dist/src/main.js", "prisma/schema.prisma"]) {
	fs.accessSync(required);
}
require("@prisma/campaigns-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/mailing/mailing.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(`Campaigns image contains monolith artifact: ${forbidden}`);
	}
}
process.stdout.write("Standalone Campaigns image artifact verified\n");
	'
}

verify_reporting_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$REPORTING_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of ["dist/src/main.js", "prisma/schema.prisma"]) {
	fs.accessSync(required);
}
require("@prisma/reporting-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/statistics/statistics.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(`Reporting image contains monolith artifact: ${forbidden}`);
	}
}
process.stdout.write("Standalone Reporting image artifact verified\n");
	'
}

verify_widgets_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$WIDGETS_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/main.js",
	"dist/src/cutover-main.js",
	"prisma/schema.prisma",
]) fs.accessSync(required);
require("@prisma/widgets-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/widgets/widgets.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/email",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(`Widgets image contains Core artifact: ${forbidden}`);
	}
}

const expectedAssets = [
	"calculator-button.png", "calculator.js", "callback-button.png", "callback.js",
	"gift-button.png", "helpers/libphonenumber-min.js",
	"helpers/winwidget-phone.js", "online-consultant-button.png",
	"online-consultant.js", "quiz-button.png", "quiz.js", "stop-offer.js",
	"timer-button.png", "timer.js", "wheel.js",
];
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
	const relative = `${directory}/${entry.name}`;
	return entry.isDirectory() ? walk(relative) : [relative.slice("public/widgets/".length)];
}).sort();
if (JSON.stringify(walk("public/widgets")) !== JSON.stringify(expectedAssets)) {
	throw new Error("Widgets runtime asset manifest drifted");
}
process.stdout.write("Standalone Widgets image artifact verified\n");
	'
}

verify_billing_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$BILLING_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/main.js",
	"dist/src/cutover-main.js",
	"prisma/schema.prisma",
]) fs.accessSync(required);
require("@prisma/billing-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/payment/payment.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(`Billing image contains Core artifact: ${forbidden}`);
	}
}

process.stdout.write("Standalone Billing image artifact verified\n");
	'
}

verify_support_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$SUPPORT_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/main.js",
	"dist/src/cutover/main.js",
	"prisma/schema.prisma",
	"prisma/migrations",
]) fs.accessSync(required);
require("@prisma/support-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/telegram-bot/telegram-bot.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(`Support image contains Core artifact: ${forbidden}`);
	}
}

process.stdout.write("Standalone Support image artifact verified\n");
	'
}

verify_core_support_runtime_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const fs = require("node:fs");
fs.accessSync("dist/src/support-cutover-main.js");
for (const file of [
	"dist/src/telegram-bot/telegram-bot.service.js",
	"dist/src/telegram-bot/telegram-bot.controller.js",
]) {
	const source = fs.readFileSync(file, "utf8");
	for (const forbidden of [
		"support-webhook",
		"TELEGRAM_SUPPORT_BOT",
		"handleSupportWebhook",
		"telegramSupportMessage",
		"setImmediate",
	]) {
		if (source.includes(forbidden)) {
			throw new Error(`Core image retains Support runtime fallback: ${forbidden}`);
		}
	}
}
const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
for (const forbidden of ["model TelegramSupportMessage", "supportThreadId"]) {
	if (schema.includes(forbidden)) {
		throw new Error(`Core Prisma schema retains Support ownership: ${forbidden}`);
	}
}
process.stdout.write("Legacy-free Core Support runtime artifact verified\n");
'
}

billing_core_cleanup_require_pinned_images() {
	local revision expected_core_id expected_billing_id core_image billing_image
	local actual_core_id actual_billing_id core_revision billing_revision core_user billing_user
	billing_core_source_cleanup_validate_marker || return 1
	revision="$(billing_core_source_cleanup_marker_value revision)" || return 1
	expected_core_id="$(billing_core_source_cleanup_marker_value cleanup_core_image_id)" || return 1
	expected_billing_id="$(billing_core_source_cleanup_marker_value cleanup_billing_image_id)" || return 1
	[[ "$revision" == "$APP_REVISION" &&
		"$expected_core_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$expected_billing_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	core_image="winwidget-api:git-$revision"
	billing_image="winwidget-billing:git-$revision"
	actual_core_id="$(docker image inspect --format '{{.Id}}' "$core_image")" || return 1
	actual_billing_id="$(docker image inspect --format '{{.Id}}' "$billing_image")" || return 1
	core_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$core_image")" || return 1
	billing_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$billing_image")" || return 1
	core_user="$(docker image inspect --format '{{.Config.User}}' "$core_image")" || return 1
	billing_user="$(docker image inspect --format '{{.Config.User}}' "$billing_image")" || return 1
	[[ "$actual_core_id" == "$expected_core_id" &&
		"$actual_billing_id" == "$expected_billing_id" &&
		"$core_revision" == "$revision" && "$billing_revision" == "$revision" &&
		-n "$core_user" && "$core_user" != '0' && "$core_user" != 'root' &&
		"$billing_user" == 'billing' ]]
}

verify_billing_core_cleanup_image_artifact() {
	[[ "$billing_core_cleanup_runtime_deploy" == 'true' ||
		"$billing_core_cleanup_marker_phase" == 'complete' ]] || return 0
	docker run --rm --network none --entrypoint node \
		"winwidget-api:$APP_VERSION" -e '
const fs = require("node:fs");
for (const required of [
  "dist/src/main.js",
  "prisma/schema.prisma",
  "prisma/migrations/20260813000000_remove_legacy_billing_core_source/migration.sql",
]) fs.accessSync(required);
for (const removed of [
  "dist/src/payment",
  "dist/src/subscription",
  "dist/src/affiliate",
  "dist/src/tariff-prices",
]) {
  if (fs.existsSync(removed)) throw new Error(`Core image retains legacy Billing artifact: ${removed}`);
}
process.stdout.write("Legacy-free Core Billing cleanup image verified\n");
'
}

verify_database_restore_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$DATABASE_RESTORE_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/database-restore-worker-main.js",
	"prisma/migrations",
	"apps/notification-delivery/prisma/migrations",
	"apps/campaigns/prisma/migrations",
	"apps/reporting/prisma/migrations",
	"apps/widgets/prisma/migrations",
	"apps/billing/prisma/migrations",
	"apps/platform/prisma/migrations",
	"apps/support/prisma/migrations",
	"/usr/bin/pg_dump",
	"/usr/bin/pg_restore",
	"/usr/bin/psql",
	"/usr/bin/flock",
	"/usr/local/bin/database-restore-entrypoint.sh",
]) {
	fs.accessSync(required);
}
process.stdout.write("Isolated database restore worker image artifact verified\n");
	'
}

validate_widgets_database_urls() {
	printf '%s\n%s\n%s\n' \
		"$(get_env_value WIDGETS_DATABASE_URL)" \
		"$(get_env_value WIDGETS_MIGRATION_DATABASE_URL)" \
		"$(get_env_value WIDGETS_BACKUP_URL)" |
		docker run --rm -i --network none \
			-e "EXPECTED_PORT=$(get_env_value WIDGETS_POSTGRES_PORT)" \
			--entrypoint node "$WIDGETS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const urls = readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const expectedUsers = [
	"winwidget_widgets_runtime",
	"winwidget_widgets_migration",
	"winwidget_widgets_backup",
];
for (const [index, url] of urls.entries()) {
	const password = decodeURIComponent(url.password);
	if (
		url.protocol !== "postgresql:" ||
		decodeURIComponent(url.username) !== expectedUsers[index] ||
		url.hostname !== "127.0.0.1" ||
		url.port !== process.env.EXPECTED_PORT ||
		url.pathname !== "/winwidget_widgets" ||
		url.searchParams.get("schema") !== "widgets" ||
		password.length < 16 ||
		/[\0\r\n]/.test(password)
	) throw new Error(`Invalid Widgets database URL boundary at index ${index}`);
}

process.stdout.write("Widgets runtime, migration and backup URL boundaries verified\n");
'
}

validate_billing_database_urls() {
	printf '%s\n%s\n%s\n' \
		"$(get_env_value BILLING_DATABASE_URL)" \
		"$(get_env_value BILLING_MIGRATION_DATABASE_URL)" \
		"$(get_env_value BILLING_BACKUP_URL)" |
		docker run --rm -i --network none \
			-e "EXPECTED_PORT=$(get_env_value BILLING_POSTGRES_PORT)" \
			--entrypoint node "$BILLING_IMAGE" -e '
const { readFileSync } = require("node:fs");
const urls = readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const expectedUsers = [
	"winwidget_billing_runtime",
	"winwidget_billing_migration",
	"winwidget_billing_backup",
];
for (const [index, url] of urls.entries()) {
	const password = decodeURIComponent(url.password);
	if (
		url.protocol !== "postgresql:" ||
		decodeURIComponent(url.username) !== expectedUsers[index] ||
		url.hostname !== "127.0.0.1" ||
		url.port !== process.env.EXPECTED_PORT ||
		url.pathname !== "/winwidget_billing" ||
		url.searchParams.get("schema") !== "billing" ||
		password.length < 16 ||
		/[\0\r\n]/.test(password)
	) throw new Error(`Invalid Billing database URL boundary at index ${index}`);
}

process.stdout.write("Billing runtime, migration and backup URL boundaries verified\n");
'
}

validate_support_database_urls() {
	printf '%s\n%s\n%s\n' \
		"$(get_env_value SUPPORT_DATABASE_URL)" \
		"$(get_env_value SUPPORT_MIGRATION_DATABASE_URL)" \
		"$(get_env_value SUPPORT_BACKUP_URL)" |
		docker run --rm -i --network none \
			-e "EXPECTED_PORT=$(get_env_value SUPPORT_POSTGRES_PORT)" \
			--entrypoint node "$SUPPORT_IMAGE" -e '
const { readFileSync } = require("node:fs");
const urls = readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const expectedUsers = [
	"winwidget_support_runtime",
	"winwidget_support_migration",
	"winwidget_support_backup",
];
for (const [index, url] of urls.entries()) {
	const password = decodeURIComponent(url.password);
	if (
		url.protocol !== "postgresql:" ||
		decodeURIComponent(url.username) !== expectedUsers[index] ||
		url.hostname !== "127.0.0.1" ||
		url.port !== process.env.EXPECTED_PORT ||
		url.pathname !== "/winwidget_support" ||
		url.searchParams.get("schema") !== "support" ||
		password.length < 16 ||
		/[\0\r\n]/.test(password)
	) throw new Error(`Invalid Support database URL boundary at index ${index}`);
}

process.stdout.write("Support runtime, migration and backup URL boundaries verified\n");
'
}

verify_support_steady_ownership() {
	local core_status support_status support_lifecycle_marker support_ownership_revision
	support_lifecycle_marker="$APP_ROOT/deploy/backend/.support-database-lifecycle-v1"
	[[ -f "$support_lifecycle_marker" && ! -L "$support_lifecycle_marker" &&
		"$(stat -c '%u:%g:%a' "$support_lifecycle_marker")" == '0:0:600' ]] || {
		echo 'Support steady ownership requires the protected lifecycle marker.' >&2
		return 1
	}
	support_ownership_revision="$(
		support_steady_ownership_revision_from_marker \
			"$support_lifecycle_marker" "$support_first_cutover_deploy"
	)" || {
		echo 'Support steady ownership lifecycle marker is invalid.' >&2
		return 1
	}
	core_status="$(
		docker run --rm --network host --env-file "$ENV_FILE" \
			--entrypoint node "winwidget-api:$APP_VERSION" \
			dist/src/support-cutover-main.js status
	)" || return 1
	support_status="$(
		docker run --rm --network host --env-file "$ENV_FILE" \
			--entrypoint node "$SUPPORT_IMAGE" \
			dist/src/cutover/main.js status
	)" || return 1
	printf '%s\n%s\n' "$core_status" "$support_status" |
		docker run --rm -i --network none \
			-e "EXPECTED_OWNERSHIP_REVISION=$support_ownership_revision" \
			--entrypoint node "$SUPPORT_IMAGE" -e '
const { readFileSync } = require("node:fs");
const lines = readFileSync(0, "utf8").trim().split("\n");
if (lines.length !== 2) throw new Error("Support ownership status shape drifted");
const [core, support] = lines.map(line => JSON.parse(line));
const exactHash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exactSystemId = value => typeof value === "string" && /^[1-9][0-9]{0,31}$/.test(value);
if (
	core.action !== "status" || core.ownership !== "SUPPORT" ||
	core.admissionEnabled !== false || core.reconcilerEnabled !== false ||
	core.activeTaskCount !== 0 || !/^[1-9][0-9]*$/.test(core.generation) ||
	core.sourceRevision !== process.env.EXPECTED_OWNERSHIP_REVISION ||
	core.ownershipRevision !== process.env.EXPECTED_OWNERSHIP_REVISION ||
	support.action !== "status" || support.phase !== "ACTIVE" ||
	!/^([1-9][0-9]*)$/.test(support.ownershipGeneration) ||
	support.sourceRevision !== process.env.EXPECTED_OWNERSHIP_REVISION ||
	support.ownershipRevision !== process.env.EXPECTED_OWNERSHIP_REVISION ||
	!exactSystemId(core.sourceDatabaseSystemId) ||
	core.sourceDatabaseSystemId !== support.sourceDatabaseSystemId ||
	!exactHash(core.sourceFingerprint) ||
	core.sourceFingerprint !== support.sourceFingerprint ||
	!exactHash(core.sourceSnapshotSha256) ||
	core.sourceSnapshotSha256 !== support.sourceSnapshotSha256 ||
	core.sourceHighWatermark !== support.sourceHighWatermark ||
	core.sourceMappingCount !== String(support.counts?.mappings) ||
	!core.activatedAt || !support.activatedAt
) throw new Error("Core and Support ownership anchors are not in exact steady state");
process.stdout.write("Core and Support ownership anchors verified\n");
'
}

validate_campaigns_database_urls() {
	printf '%s\n%s\n%s\n' \
		"$(get_env_value CAMPAIGNS_DATABASE_URL)" \
		"$(get_env_value CAMPAIGNS_MIGRATION_DATABASE_URL)" \
		"$(get_env_value CAMPAIGNS_BACKUP_URL)" |
		docker run --rm -i --network none \
			-e "EXPECTED_PORT=$(get_env_value CAMPAIGNS_POSTGRES_PORT)" \
			--entrypoint node "$CAMPAIGNS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const urls = readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const expectedUsers = [
	"winwidget_campaigns_runtime",
	"winwidget_campaigns_migration",
	"winwidget_campaigns_backup",
];
for (const [index, url] of urls.entries()) {
	const user = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	if (
		url.protocol !== "postgresql:" ||
		user !== expectedUsers[index] ||
		url.hostname !== "127.0.0.1" ||
		url.port !== process.env.EXPECTED_PORT ||
		url.pathname !== "/winwidget_campaigns" ||
		url.searchParams.get("schema") !== "campaigns" ||
		password.length < 16 ||
		/[\0\r\n]/.test(password)
	) {
		throw new Error(`Invalid Campaigns database URL boundary at index ${index}`);
	}
}
process.stdout.write("Campaigns runtime, migration and backup URL boundaries verified\n");
'
}

initialize_notification_database_lifecycle_guard \
	true \
	"a routine full deployment" \
	identity-if-present

compose_target \
	--profile migration \
	--profile notification-delivery-migration \
	--profile campaigns-migration \
	--profile reporting-migration \
	--profile widgets-migration \
	--profile billing-migration \
	--profile identity-migration \
	--profile support-migration \
	config --quiet
routine_build_services=(
	maintenance-worker
	database-restore-worker
	notification-delivery-worker
	campaigns-service
	reporting-service
	widgets-service
	identity-api
)
if [[ "$support_first_cutover_deploy" == 'false' ]]; then
	routine_build_services+=(api-gateway support-api)
fi
if [[ "$billing_core_cleanup_marker_phase" == 'complete' ]]; then
	routine_build_services+=(billing-api)
	if [[ "$support_first_cutover_deploy" == 'false' ]]; then
		routine_build_services+=(api)
	fi
else
	billing_database_require_pinned_candidate_images || {
		echo 'Pinned historical Core/Billing candidate images are unavailable or changed.' >&2
		exit 1
	}
fi
if [[ "$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
	billing_core_cleanup_require_pinned_images || {
		echo 'Pinned Billing Core cleanup images are unavailable or changed.' >&2
		exit 1
	}
fi
compose_target build --provenance=false "${routine_build_services[@]}"
if [[ "$billing_core_cleanup_marker_phase" != 'complete' ]]; then
	billing_database_require_pinned_candidate_images || {
		echo 'Pinned historical Core/Billing candidate images changed during the full build.' >&2
		exit 1
	}
fi
if [[ "$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
	billing_core_cleanup_require_pinned_images || {
		echo 'Pinned Billing Core cleanup images changed during the full build.' >&2
		exit 1
	}
fi
verify_notification_delivery_image_artifact
verify_campaigns_image_artifact
verify_reporting_image_artifact
verify_widgets_image_artifact
verify_billing_image_artifact
verify_support_image_artifact
verify_core_support_runtime_artifact
verify_billing_core_cleanup_image_artifact
verify_database_restore_image_artifact
validate_campaigns_database_urls
validate_widgets_database_urls
validate_billing_database_urls
validate_support_database_urls
assert_campaigns_contract_migration_applied_for_routine_deploy
initialize_campaigns_database_lifecycle_guard \
	"a routine full deployment" identity-if-present
reporting_initialize_database_guard "a routine full deployment" \
	identity-if-present

validate_notification_database_urls() {
	local parser_image="$1"
	local runtime_url
	local migration_url
	local backup_url

	runtime_url="$(get_env_value NOTIFICATION_DELIVERY_DATABASE_URL)"
	migration_url="$(
		get_env_value NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
	)"
	backup_url="$(get_env_value NOTIFICATION_DELIVERY_BACKUP_URL)"

	if ! printf '%s\n%s\n%s\n' "$runtime_url" "$migration_url" "$backup_url" |
		docker run --rm -i --network none \
			-e "NOTIFICATION_DATABASE_CUTOVER_ACTIVE=$notification_database_cutover_active" \
			-e "NOTIFICATION_DATABASE_TARGET_PORT=$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)" \
			--entrypoint node \
			"$parser_image" \
			-e '
const { readFileSync } = require("node:fs");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};
const input = readFileSync(0, "utf8");
const lines = input.endsWith("\n")
	? input.slice(0, -1).split("\n")
	: input.split("\n");
if (lines.length !== 3 || lines.some(value => !value)) {
	fail("Notification delivery PostgreSQL URLs are missing or contain a newline");
}

const parse = (value, label) => {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`${label} is not a valid URL`);
	}
	if (!["postgres:", "postgresql:"].includes(url.protocol)) {
		fail(`${label} must use postgres or postgresql`);
	}
	if (
		!url.hostname ||
		!url.username ||
		!url.password ||
		url.hash ||
		(url.port && !/^[0-9]+$/.test(url.port))
	) {
		fail(`${label} must contain explicit credentials, host and a valid port`);
	}

	let username;
	let database;
	try {
		username = decodeURIComponent(url.username);
		database = decodeURIComponent(url.pathname.slice(1));
	} catch {
		fail(`${label} contains invalid percent-encoding`);
	}
	if (
		!username ||
		!/^[A-Za-z0-9._-]+$/.test(username) ||
		!database ||
		database.includes("/")
	) {
		fail(`${label} contains an invalid role or database name`);
	}

	const schemas = url.searchParams.getAll("schema");
	if (
		schemas.length !== 1 ||
		schemas[0] !== "notification_delivery"
	) {
		fail(`${label} must contain exactly schema=notification_delivery`);
	}

	const ssl = [...url.searchParams.entries()]
		.filter(([key]) => {
			const normalized = key.toLowerCase();
			return (
				normalized.startsWith("ssl") ||
				normalized === "channel_binding"
			);
		})
		.map(([key, entryValue]) => [
			key.toLowerCase(),
			entryValue,
		])
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey
				? leftValue.localeCompare(rightValue)
				: leftKey.localeCompare(rightKey),
		);

	return {
		protocol: url.protocol,
		host: url.hostname.toLowerCase(),
		port: url.port || "5432",
		database,
		username,
		ssl: JSON.stringify(ssl),
	};
};

const runtime = parse(lines[0], "NOTIFICATION_DELIVERY_DATABASE_URL");
const migration = parse(
	lines[1],
	"NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION",
);
const backup = parse(lines[2], "NOTIFICATION_DELIVERY_BACKUP_URL");
const targetPort = process.env.NOTIFICATION_DATABASE_TARGET_PORT;
const cutoverActive =
	process.env.NOTIFICATION_DATABASE_CUTOVER_ACTIVE === "true";
const targetsCanonicalEndpoint =
	runtime.host === "127.0.0.1" && runtime.port === targetPort;
const targetsLocalEndpoint =
	["127.0.0.1", "localhost", "[::1]"].includes(runtime.host) &&
	runtime.port === targetPort;
const targetsLocalDatabase =
	targetsCanonicalEndpoint &&
	runtime.database === "winwidget_notification_delivery";
if (cutoverActive && !targetsLocalDatabase) {
	fail(
		"After database cutover, Notification delivery PostgreSQL URLs must target 127.0.0.1, the canonical port and database winwidget_notification_delivery",
	);
}
if (
	cutoverActive &&
	runtime.ssl !== JSON.stringify([["sslmode", "disable"]])
) {
	fail(
		"After database cutover, Notification delivery PostgreSQL URLs must contain exactly sslmode=disable",
	);
}
if (
	!cutoverActive &&
	(
		targetsLocalEndpoint ||
		runtime.database === "winwidget_notification_delivery"
	)
) {
	fail(
		"The local Notification Delivery database cannot be selected before the durable database cutover marker",
	);
}
for (const candidate of [migration, backup]) {
	for (const key of ["protocol", "host", "port", "database", "ssl"]) {
		if (runtime[key] === candidate[key]) continue;
		fail(
			"Notification delivery runtime, migration and backup URLs must target the same protocol, host, port, database and SSL settings",
		);
	}
}
if (new Set([runtime.username, migration.username, backup.username]).size !== 3) {
	fail(
		"Notification delivery runtime, migration and backup URLs must use distinct roles",
	);
}
process.stdout.write("Notification delivery PostgreSQL URL structure validated\n");
'; then
		exit 1
	fi
}

normalize_csv() {
	tr ',' '\n' <<<"$1" |
		sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		sed '/^$/d' |
		LC_ALL=C sort -u |
		paste -sd, -
}

container_env_value() {
	local container_id="$1"
	local key="$2"

	docker inspect --format '{{ range .Config.Env }}{{ println . }}{{ end }}' \
		"$container_id" |
		awk -F= -v key="$key" '
			$1 == key {
				sub(/^[^=]*=/, "")
				print
				found = 1
				exit
			}
			END { exit(found ? 0 : 1) }
		'
}

assert_telegram_proxy_runtime() {
	local service container_id base_url extra_hosts

	for service in api identity-api notification-delivery-worker maintenance-worker support-api support-worker; do
		container_id="$(compose_target ps --status running -q "$service")" || return 1
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
		base_url="$(container_env_value "$container_id" TELEGRAM_API_BASE_URL)" || return 1
		[[ "$base_url" == 'https://tg.winwidget.ru/telegram-api' ]] || return 1
		extra_hosts="$(
			docker inspect --format '{{range .HostConfig.ExtraHosts}}{{println .}}{{end}}' \
				"$container_id" | sed 's/=/:/'
		)" || return 1
		[[ "$extra_hosts" == "tg.winwidget.ru:$telegram_api_proxy_ip" ]] || return 1
	done
}

assert_clean_core_identity_environment_boundary() {
	local core_container identity_container integration_container support_api_container support_worker_container
	local core_keys identity_keys integration_keys support_api_keys support_worker_keys key
	core_container="$(compose_target ps --status running -q api)" || return 1
	identity_container="$(compose_target ps --status running -q identity-api)" || return 1
	integration_container="$(compose_target ps --status running -q integration-worker)" || return 1
	support_api_container="$(compose_target ps --status running -q support-api)" || return 1
	support_worker_container="$(compose_target ps --status running -q support-worker)" || return 1
	[[ "$core_container" =~ ^[0-9a-f]{64}$ &&
		"$identity_container" =~ ^[0-9a-f]{64}$ &&
		"$integration_container" =~ ^[0-9a-f]{64}$ &&
		"$support_api_container" =~ ^[0-9a-f]{64}$ &&
		"$support_worker_container" =~ ^[0-9a-f]{64}$ ]] || return 1
	core_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$core_container" | awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	identity_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$identity_container" | awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	integration_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$integration_container" | awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	support_api_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$support_api_container" | awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	support_worker_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$support_worker_container" | awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	for key in JWT_ACCESS_PRIVATE_KEY_BASE64 JWT_ACCESS_JWKS_BASE64 JWT_ACCESS_ACTIVE_KID \
		RECAPTCHA_SECRET_KEY RECAPTCHA_CLIENT_URL RECAPTCHA_ENABLED RECAPTCHA_MIN_SCORE \
		SMTP_LOGIN SMTP_PASSWORD SMTP_SERVER SMTP_CONNECTION_TIMEOUT_MS \
		SMTP_GREETING_TIMEOUT_MS SMTP_SOCKET_TIMEOUT_MS \
		SMSAERO_EMAIL SMSAERO_API_KEY SMSAERO_SIGN \
		GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_CALLBACK_URL \
		GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_CALLBACK_URL \
		YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET YANDEX_CALLBACK_URL \
		VK_CLIENT_ID VK_CLIENT_SECRET VK_SERVICE_TOKEN VK_CALLBACK_URL \
		TELEGRAM_AUTH_BOT_TOKEN TELEGRAM_AUTH_BOT_USERNAME TELEGRAM_AUTH_BOT_WEBHOOK_SECRET \
		TELEGRAM_INFO_BOT_WEBHOOK_SECRET; do
		! grep -Fxq "$key" <<<"$core_keys" || {
			echo "Clean Core API unexpectedly receives Identity-owned $key." >&2
			return 1
		}
		! grep -Fxq "$key" <<<"$integration_keys" || {
			echo "Clean Core integration worker unexpectedly receives Identity-owned $key." >&2
			return 1
		}
		grep -Fxq "$key" <<<"$identity_keys" || {
			echo "Identity API is missing required Identity-owned $key." >&2
			return 1
		}
	done
	for key in TELEGRAM_INFO_BOT_TOKEN TELEGRAM_INFO_BOT_USERNAME; do
		grep -Fxq "$key" <<<"$core_keys" || {
			echo "Clean Core API is missing required $key." >&2
			return 1
		}
	done
	for key in TELEGRAM_SUPPORT_BOT_TOKEN TELEGRAM_SUPPORT_BOT_USERNAME \
		TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET; do
		! grep -Fxq "$key" <<<"$core_keys" || {
			echo "Clean Core API unexpectedly receives Support-owned $key." >&2
			return 1
		}
		! grep -Fxq "$key" <<<"$integration_keys" || {
			echo "Core integration worker unexpectedly receives Support-owned $key." >&2
			return 1
		}
		grep -Fxq "$key" <<<"$support_api_keys" || {
			echo "Support API is missing required $key." >&2
			return 1
		}
		grep -Fxq "$key" <<<"$support_worker_keys" || {
			echo "Support worker is missing required $key." >&2
			return 1
		}
	done
	for key in TELEGRAM_INFO_BOT_TOKEN TELEGRAM_INFO_BOT_USERNAME \
		TELEGRAM_INFO_BOT_WEBHOOK_SECRET TELEGRAM_WEBHOOK_HOST; do
		grep -Fxq "$key" <<<"$identity_keys" || {
			echo "Identity API is missing required Info webhook setting $key." >&2
			return 1
		}
	done
}

validate_notification_cutover_marker() {
	local marker_path="${1:-$NOTIFICATION_DELIVERY_CUTOVER_MARKER}"
	local marker_mode
	local marker_owner

	if [[ ! -f "$marker_path" ||
		-L "$marker_path" ]]; then
		return 1
	fi
	marker_mode="$(stat -c '%a' "$marker_path")"
	marker_owner="$(stat -c '%u' "$marker_path")"
	if [[ "$marker_mode" != "600" ||
		"$marker_owner" != "$(id -u)" ]]; then
		return 1
	fi
	awk '
		NR == 1 && $0 ~ /^revision=[0-9a-f]{40}$/ { revision = 1; next }
		NR == 2 &&
			$0 ~ /^created_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/ {
			created = 1
			next
		}
		{ invalid = 1 }
		END {
			exit(revision && created && NR == 2 && !invalid ? 0 : 1)
		}
	' "$marker_path"
}

validate_notification_database_urls "winwidget-api:$APP_VERSION"

if ! validate_notification_cutover_marker \
	"$NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER"; then
	echo "The verified initial Notification Delivery cutover marker is required before moving Telegram payment/limit delivery." >&2
	echo "Restore $NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER from the completed first cutover; do not infer ownership automatically." >&2
	exit 1
fi

notification_migration_files="$(
	git -C "$server_root" ls-files \
		'apps/notification-delivery/prisma/migrations/*/migration.sql'
)"
if [[ -z "$notification_migration_files" ]]; then
	echo "No versioned notification delivery migration was found." >&2
	exit 1
fi
while IFS= read -r notification_migration_file; do
	[[ -n "$notification_migration_file" ]] || continue
	if [[ "$notification_migration_file" == \
		"apps/notification-delivery/prisma/migrations/20260727000000_init_notification_delivery/migration.sql" ]]; then
		if grep -Eiq \
			'(^|[[:space:]])CREATE[[:space:]]+(SCHEMA|EXTENSION)([[:space:]]|$)' \
			"$server_root/$notification_migration_file"; then
			echo "Initial Notification Delivery migration must use the pre-provisioned schema without database CREATE privileges." >&2
			exit 1
		fi
		continue
	fi
	# Review CHECK replacements per immutable migration so future changes fail closed.
	expected_notification_constraint_replacements=""
	case "$notification_migration_file" in
		apps/notification-delivery/prisma/migrations/20260728000000_expand_notification_delivery_telegram_kinds/migration.sql)
			expected_notification_constraint_replacements="DELIVERY_RECEIPTS_IDENTITY_CHECK,DELIVERY_FAILURES_CLASSIFICATION_CHECK,CONTROL_ACTIONS_IDENTITY_CHECK,NOTIFICATION_OUTBOX_EVENTS_IDENTITY_CHECK"
			;;
		apps/notification-delivery/prisma/migrations/20260730020000_allow_campaign_delivery_outcome_v2/migration.sql)
			expected_notification_constraint_replacements="NOTIFICATION_OUTBOX_EVENTS_IDENTITY_CHECK"
			;;
		apps/notification-delivery/prisma/migrations/20260804030000_split_reporting_delivery_outcome_route/migration.sql)
			expected_notification_constraint_replacements="NOTIFICATION_OUTBOX_EVENTS_IDENTITY_CHECK"
			;;
	esac
	if ! awk \
		-v expected_replacements="$expected_notification_constraint_replacements" '
		BEGIN {
			RS = ";"
			failed = 0
			constraint_names[1] = "DELIVERY_RECEIPTS_IDENTITY_CHECK"
			constraint_names[2] = "DELIVERY_FAILURES_CLASSIFICATION_CHECK"
			constraint_names[3] = "CONTROL_ACTIONS_IDENTITY_CHECK"
			constraint_names[4] = "NOTIFICATION_OUTBOX_EVENTS_IDENTITY_CHECK"
			table_names[1] = "DELIVERY_RECEIPTS"
			table_names[2] = "DELIVERY_FAILURES"
			table_names[3] = "CONTROL_ACTIONS"
			table_names[4] = "OUTBOX_EVENTS"
			expected_count = split(expected_replacements, expected_names, ",")
			for (i = 1; i <= expected_count; i += 1) {
				if (expected_names[i] != "") {
					expected[expected_names[i]] = 1
				}
			}
		}
		{
			statement = $0
			gsub(/--[^\n]*/, "", statement)
			gsub(/[[:space:]]+/, " ", statement)
			sub(/^[[:space:]]+/, "", statement)
			sub(/[[:space:]]+$/, "", statement)
			if (statement == "") next
			upper = toupper(statement)
			if (upper == "BEGIN") {
				transaction_begin += 1
				next
			}
			if (upper == "COMMIT") {
				transaction_commit += 1
				next
			}
			if (upper ~ /^CREATE (TYPE|TABLE|INDEX|UNIQUE INDEX) / || upper ~ /^ALTER TYPE .* ADD VALUE /) next
			additive_column = upper ~ /^ALTER TABLE .* ADD COLUMN /
			additive_column = additive_column && upper !~ / NOT NULL/
			additive_column = additive_column && upper !~ / DEFAULT /
			additive_column = additive_column && upper !~ / UNIQUE/
			additive_column = additive_column && upper !~ / PRIMARY KEY/
			additive_column = additive_column && upper !~ / REFERENCES /
			additive_column = additive_column && upper !~ / CHECK[[:space:]]*\(/
			additive_column = additive_column && upper !~ / GENERATED /
			additive_column = additive_column && upper !~ / IDENTITY/
			if (additive_column) next
			accepted_replacement = 0
			for (i = 1; i <= 4; i += 1) {
				name = constraint_names[i]
				table_name = table_names[i]
				pattern = "^ALTER TABLE \"NOTIFICATION_DELIVERY\"\\.\"" table_name "\" DROP CONSTRAINT \"" name "\", ADD CONSTRAINT \"" name "\" CHECK[[:space:]]*\\("
				candidate = upper
				constraint_replacement = candidate ~ pattern
				constraint_replacement = constraint_replacement && gsub(/DROP CONSTRAINT/, "", candidate) == 1
				constraint_replacement = constraint_replacement && gsub(/ADD CONSTRAINT/, "", candidate) == 1
				constraint_replacement = constraint_replacement && gsub(/ALTER TABLE/, "", candidate) == 1
				constraint_replacement = constraint_replacement && candidate !~ /( CASCADE| DROP COLUMN| TRUNCATE | DELETE FROM | UPDATE | INSERT INTO | CREATE )/
				if (constraint_replacement) {
					if (!expected[name]) failed = 1
					replaced[name] += 1
					replaced_constraints = 1
					accepted_replacement = 1
					break
				}
			}
			if (accepted_replacement) next
			failed = 1
		}
		END {
			for (i = 1; i <= 4; i += 1) {
				name = constraint_names[i]
				required_replacements = expected[name] ? 1 : 0
				if (replaced[name] != required_replacements) failed = 1
			}
			invalid_transaction = transaction_begin != transaction_commit
			invalid_transaction = invalid_transaction || transaction_begin > 1
			invalid_transaction = invalid_transaction || transaction_commit > 1
			invalid_transaction = invalid_transaction || (transaction_begin && !replaced_constraints)
			invalid_transaction = invalid_transaction || (replaced_constraints && (transaction_begin != 1 || transaction_commit != 1))
			if (invalid_transaction) failed = 1
			exit(failed ? 1 : 0)
		}
	' "$server_root/$notification_migration_file"; then
		echo "Notification delivery migration is not provably additive: $notification_migration_file" >&2
		echo "Production notification migrations must follow the expand/contract policy." >&2
		exit 1
	fi
done <<<"$notification_migration_files"

notification_delivery_first_cutover=false
notification_forward_candidate_active=false
notification_forward_candidate_needs_recovery=false
notification_cutover_marker_revision=""
notification_cutover_candidate_services=(
	outbox-publisher
	integration-worker
	maintenance-worker
	notification-delivery-worker
	api
	api-gateway
)
notification_cutover_pre_marker_services=(
	integration-worker
	maintenance-worker
	notification-delivery-worker
	api
)
notification_delivery_container_ids="$(
	compose_target ps -a -q notification-delivery-worker 2>/dev/null || true
)"
running_notification_delivery_container_id="$(
	compose_target ps --status running -q notification-delivery-worker \
		2>/dev/null || true
)"
current_integration_container_id="$(
	compose_target ps --status running -q integration-worker 2>/dev/null || true
)"
notification_cutover_candidate_ids="$(
	compose_notification_cutover ps -a -q \
		"${notification_cutover_candidate_services[@]}" 2>/dev/null || true
)"
narrow_integration_kinds="$(
	normalize_csv \
		"$expected_integration_worker_kinds"
)"
pre_reporting_narrow_integration_kinds="$(
	normalize_csv \
		"webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,auto-renewal"
)"
pre_billing_narrow_integration_kinds="$(
	normalize_csv \
		"telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,reporting-admin-audit,widgets-admin-audit,auto-renewal"
)"
broad_integration_kinds="$(
	normalize_csv \
		"webhook,bitrix24,amo-crm,payment-telegram,limit-telegram,daily-summary-telegram"
)"
legacy_notification_delivery_kinds="$(
	normalize_csv \
		"email,telegram,payment-email,limit-email"
)"
expanded_notification_delivery_kinds="$(
	normalize_csv \
		"email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram"
)"

if [[ -e "$NOTIFICATION_DELIVERY_CUTOVER_MARKER" ||
	-L "$NOTIFICATION_DELIVERY_CUTOVER_MARKER" ]]; then
	if ! validate_notification_cutover_marker; then
		echo "Notification delivery cutover marker has invalid type, ownership, mode or content." >&2
		exit 1
	fi
	notification_cutover_marker_revision="$(
		sed -n 's/^revision=//p' "$NOTIFICATION_DELIVERY_CUTOVER_MARKER"
	)"

	candidate_topology_complete=true
	for service in "${notification_cutover_candidate_services[@]}"; do
		candidate_service_id="$(
			compose_notification_cutover ps --status running -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$candidate_service_id" ||
			"$candidate_service_id" == *$'\n'* ]]; then
			candidate_topology_complete=false
			break
		fi
	done
	if [[ "$candidate_topology_complete" == "true" ]]; then
		if ! verify_saved_notification_cutover_containers \
			"$notification_cutover_marker_revision"; then
			echo "Running forward cutover topology does not match its durable marker." >&2
			exit 1
		fi
		if [[ -n "$current_integration_container_id" ]]; then
			echo "Both canonical and forward-candidate integration workers are running after cutover." >&2
			exit 1
		fi
		candidate_integration_container_id="$(
			compose_notification_cutover ps --status running -q integration-worker
		)"
		candidate_integration_kinds="$(
			container_env_value \
				"$candidate_integration_container_id" \
				INTEGRATION_WORKER_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_integration_kinds")" != "$narrow_integration_kinds" ]]; then
			echo "Forward cutover topology has an unexpected integration kind set." >&2
			exit 1
		fi
		candidate_notification_container_id="$(
			compose_notification_cutover ps --status running -q \
				notification-delivery-worker
		)"
		candidate_notification_kinds="$(
			container_env_value \
				"$candidate_notification_container_id" \
				NOTIFICATION_DELIVERY_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_notification_kinds")" != "$expanded_notification_delivery_kinds" ]]; then
			echo "Forward cutover topology has an unexpected Notification Delivery kind set." >&2
			exit 1
		fi
		notification_forward_candidate_active=true
	elif [[ -n "$notification_cutover_candidate_ids" ]]; then
		if ! verify_saved_notification_cutover_containers \
			"$notification_cutover_marker_revision"; then
			echo "Cutover marker exists, but the saved forward-candidate topology is incomplete or has drifted." >&2
			echo "Do not remove its containers; repair the exact saved topology before retrying." >&2
			exit 1
		fi
		canonical_cutover_service_ids="$(
			compose_target ps --status running -q \
				"${notification_cutover_candidate_services[@]}" \
				2>/dev/null || true
		)"
		if [[ -n "$canonical_cutover_service_ids" ]]; then
			echo "Cutover marker exists with an incomplete saved topology and running canonical services." >&2
			echo "Refusing automatic recovery while service ownership is ambiguous." >&2
			exit 1
		fi
		candidate_integration_container_id="$(
			notification_cutover_container_id integration-worker
		)"
		candidate_integration_kinds="$(
			container_env_value \
				"$candidate_integration_container_id" \
				INTEGRATION_WORKER_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_integration_kinds")" != "$narrow_integration_kinds" ]]; then
			echo "Saved forward cutover integration worker has an unexpected kind set." >&2
			exit 1
		fi
		candidate_notification_container_id="$(
			notification_cutover_container_id notification-delivery-worker
		)"
		candidate_notification_kinds="$(
			container_env_value \
				"$candidate_notification_container_id" \
				NOTIFICATION_DELIVERY_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_notification_kinds")" != "$expanded_notification_delivery_kinds" ]]; then
			echo "Saved forward cutover Notification Delivery worker has an unexpected kind set." >&2
			exit 1
		fi
		notification_forward_candidate_active=true
		notification_forward_candidate_needs_recovery=true
		echo "Saved forward cutover topology is incomplete but exact and recoverable."
	else
		if [[ -z "$running_notification_delivery_container_id" ||
			"$running_notification_delivery_container_id" == *$'\n'* ||
			-z "$current_integration_container_id" ||
			"$current_integration_container_id" == *$'\n'* ]]; then
			if [[ "$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
				echo 'Billing cleanup will validate the exact stopped Notification Delivery and integration workers from sealed evidence.'
			else
				reporting_outcome_route_state_before="$(
					reporting_outcome_route_topology_state
				)" || exit 1
				if detect_interrupted_reporting_outcome_deploy \
					"$reporting_outcome_route_state_before"; then
					reporting_interrupted_routine_recovery=true
				else
					echo "Cutover marker exists, but neither canonical nor saved forward topology is complete." >&2
					echo "Resolve the topology manually; forward-only cutover state cannot be inferred safely." >&2
					exit 1
				fi
			fi
		fi
		if [[ "$reporting_interrupted_routine_recovery" != 'true' &&
			"$billing_core_cleanup_runtime_deploy" != 'true' ]]; then
			current_integration_kinds="$(
				container_env_value \
					"$current_integration_container_id" \
					INTEGRATION_WORKER_KINDS || true
			)"
			current_integration_kinds_normalized="$(
				normalize_csv "$current_integration_kinds"
			)"
			if reporting_cutover_worker_kinds_allowed \
				"$current_integration_kinds_normalized" \
				"$narrow_integration_kinds" \
				"$pre_reporting_narrow_integration_kinds"; then
				:
			elif [[ "$billing_database_phase" == 'prepared' &&
				"$current_integration_kinds_normalized" == \
				"$pre_billing_narrow_integration_kinds" ]]; then
				echo 'Allowing the pre-Billing integration worker only for its one-way Billing consumer bootstrap.'
			else
				echo "Cutover marker exists, but the live integration worker still owns an unexpected kind set." >&2
				echo "Do not attempt an automatic legacy rollback after the cutover marker." >&2
				exit 1
			fi
			if [[ "$current_integration_kinds_normalized" != "$narrow_integration_kinds" ]]; then
				echo 'The integration worker will be recreated with the current exact ownership contract.'
			fi
			current_notification_delivery_kinds="$(
				container_env_value \
					"$running_notification_delivery_container_id" \
					NOTIFICATION_DELIVERY_KINDS || true
			)"
			if [[ "$(normalize_csv "$current_notification_delivery_kinds")" != "$expanded_notification_delivery_kinds" ]]; then
				echo "Cutover marker exists, but the live Notification Delivery worker has an unexpected kind set." >&2
				exit 1
			fi
		fi
	fi
else
	if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
		reporting_cutover_validate_marker || {
			echo 'Reporting cutover marker is invalid while Notification Delivery marker is missing.' >&2
			exit 1
		}
		echo 'Notification Delivery marker is missing after the Reporting cutover started.' >&2
		echo 'Routine deploy must not replay the historical provider cutover or recreate legacy Reporting topology.' >&2
		exit 1
	fi
	if [[ -n "$notification_cutover_candidate_ids" ]]; then
		echo "Forward cutover containers exist without the durable marker." >&2
		echo "Restore the exact legacy containers or remove only the verified stale cutover project." >&2
		exit 1
	fi
	if [[ -z "$running_notification_delivery_container_id" ||
		"$running_notification_delivery_container_id" == *$'\n'* ||
		"$notification_delivery_container_ids" == *$'\n'* ]]; then
		echo "Exactly one running canonical Notification Delivery worker is required before the Telegram ownership cutover." >&2
		exit 1
	fi
	if [[ -z "$current_integration_container_id" ||
		"$current_integration_container_id" == *$'\n'* ]]; then
		echo "Exactly one running v1 integration worker is required before the Telegram cutover." >&2
		exit 1
	fi
	current_integration_kinds="$(
		container_env_value \
			"$current_integration_container_id" \
			INTEGRATION_WORKER_KINDS || true
	)"
	if [[ "$(normalize_csv "$current_integration_kinds")" != "$broad_integration_kinds" ]]; then
		echo "Telegram cutover marker is missing and the live integration worker is not the exact v1 owner." >&2
		echo "Refusing to guess whether a previous cutover partially completed." >&2
		exit 1
	fi
	current_notification_delivery_kinds="$(
		container_env_value \
			"$running_notification_delivery_container_id" \
			NOTIFICATION_DELIVERY_KINDS || true
	)"
	if [[ "$(normalize_csv "$current_notification_delivery_kinds")" != "$legacy_notification_delivery_kinds" ]]; then
		echo "Telegram cutover marker is missing and the live Notification Delivery worker is not the exact four-kind v1 owner." >&2
		exit 1
	fi
	current_integration_rabbit_url="$(
		container_env_value \
			"$current_integration_container_id" \
			RABBITMQ_URL || true
	)"
	current_outbox_container_id="$(
		compose_target ps --status running -q outbox-publisher 2>/dev/null || true
	)"
	if [[ -z "$current_outbox_container_id" ||
		"$current_outbox_container_id" == *$'\n'* ]]; then
		echo "Exactly one running v1 Outbox publisher is required before the Telegram cutover." >&2
		exit 1
	fi
	current_outbox_rabbit_url="$(
		container_env_value \
			"$current_outbox_container_id" \
			RABBITMQ_URL || true
	)"
	if [[ "$current_integration_rabbit_url" != "$(get_env_value RABBITMQ_INTEGRATION_WORKER_URL)" ||
		"$current_outbox_rabbit_url" != "$(get_env_value RABBITMQ_PUBLISHER_URL)" ]]; then
		echo "First cutover cannot rotate the live legacy integration or Outbox RabbitMQ credentials." >&2
		echo "Deploy the credential rotation separately, then retry the full notification cutover." >&2
		exit 1
	fi
	notification_delivery_first_cutover=true
fi

if [[ "$notification_forward_candidate_active" == "true" ]]; then
	if ! git -C "$server_root" cat-file -e \
		"${notification_cutover_marker_revision}^{commit}" 2>/dev/null; then
		echo "The saved forward cutover revision is not available in this checkout." >&2
		echo "Fetch the marker revision before attempting canonical handoff." >&2
		exit 1
	fi
	if ! git -C "$server_root" merge-base --is-ancestor \
		"$notification_cutover_marker_revision" "$deploy_revision"; then
		echo "The current revision is not a descendant of the saved forward cutover revision." >&2
		echo "Canonicalize the marker revision before deploying a divergent history." >&2
		exit 1
	fi
	forward_recovery_schema_changes="$(
		git -C "$server_root" diff --name-only \
			"$notification_cutover_marker_revision" "$deploy_revision" -- \
			prisma/migrations \
			apps/notification-delivery/prisma/migrations
	)"
	if [[ -n "$forward_recovery_schema_changes" ]]; then
		echo "A saved forward topology cannot protect a deployment that changes PostgreSQL migrations." >&2
		echo "Canonicalize the marker revision first, then deploy the newer migrations:" >&2
		printf '%s\n' "$forward_recovery_schema_changes" >&2
		exit 1
	fi
fi

gateway_validation_env=()
for key in \
	GATEWAY_LISTEN_HOST \
	GATEWAY_PORT \
	GATEWAY_ROUTES_JSON \
	CORS_ALLOWED_ORIGINS \
	JWT_JWKS_URL \
	JWT_ISSUER \
	JWT_AUDIENCE \
	JWT_CLOCK_TOLERANCE_SECONDS \
	JWT_MAX_TOKEN_BYTES \
	JWKS_FETCH_TIMEOUT_MS \
	JWKS_REFRESH_MIN_INTERVAL_MS \
	JWKS_CACHE_TTL_MS \
	JWKS_MAX_STALE_MS \
	JWKS_MAX_BYTES; do
	value="$(get_env_value "$key" || true)"
	if [[ -n "$value" ]]; then
		gateway_validation_env+=(--env "$key=$value")
	fi
done
gateway_validation_env+=(
	--env "JWT_MAX_TOKEN_LIFETIME_SECONDS=$(get_env_value JWT_ACCESS_TTL_SECONDS)"
	--env "SHUTDOWN_GRACE_MS=$(get_env_value GATEWAY_SHUTDOWN_GRACE_MS)"
	--env "REPORTING_GATEWAY_POLICY=$reporting_gateway_policy"
	--env "BILLING_GATEWAY_POLICY=$billing_routes_env_state"
	--env "IDENTITY_GATEWAY_POLICY=$identity_routes_env_state"
	--env "PLATFORM_GATEWAY_POLICY=platform"
)
gateway_route_manifest_policy_validator="$(gateway_route_manifest_policy_validator_source)"
gateway_validation_env+=(
	--env "GATEWAY_ROUTE_MANIFEST_POLICY_VALIDATOR=$gateway_route_manifest_policy_validator"
)

docker run --rm --network none \
	"${gateway_validation_env[@]}" \
	--entrypoint node \
	"winwidget-api-gateway:$APP_VERSION" \
	-e '
eval(process.env.GATEWAY_ROUTE_MANIFEST_POLICY_VALIDATOR);
const { loadConfig } = require("./dist/src/config.js");
const config = loadConfig();
const reportingPolicy = process.env.REPORTING_GATEWAY_POLICY;
const billingPolicy = process.env.BILLING_GATEWAY_POLICY;
const identityPolicy = process.env.IDENTITY_GATEWAY_POLICY;
const platformPolicy = process.env.PLATFORM_GATEWAY_POLICY;
validateGatewayRouteManifest(config, reportingPolicy, billingPolicy, identityPolicy, platformPolicy);
process.stdout.write(
	"API Gateway route manifest validated for Reporting policy " + reportingPolicy +
		", Billing policy " + billingPolicy +
		", Identity policy " + identityPolicy +
		", and Platform policy " + platformPolicy + "\\n",
);
'

if [[ "$reporting_gateway_policy" == 'reporting' &&
	"$billing_core_cleanup_runtime_deploy" != 'true' ]]; then
	reporting_cutover_require_forward_scheduler_ready || {
		echo 'Reporting runtime/owner preflight failed before the public Gateway route switch.' >&2
		exit 1
	}
fi

docker run --rm --network none \
	--env-file "$ENV_FILE" \
	--entrypoint node \
	"${IDENTITY_IMAGE:-winwidget-identity:git-$deploy_revision}" \
	-e '
const {
	createPrivateKey,
	createPublicKey,
	randomBytes,
	sign,
	verify,
} = require("node:crypto");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let privateKey;
let jwks;
try {
	privateKey = createPrivateKey(
		Buffer.from(process.env.IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64 || "", "base64"),
	);
	jwks = JSON.parse(
		Buffer.from(process.env.IDENTITY_JWT_ACCESS_JWKS_BASE64 || "", "base64").toString(
			"utf8",
		),
	);
} catch {
	fail("JWT key material is malformed");
}

if (
	privateKey.type !== "private" ||
	privateKey.asymmetricKeyType !== "rsa" ||
	(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072
) {
	fail("JWT private key must be an RSA key of at least 3072 bits");
}
if (!Array.isArray(jwks?.keys) || !jwks.keys.length) {
	fail("JWT JWKS must contain at least one public key");
}

const keyIds = new Set();
for (const key of jwks.keys) {
	if (
		!key ||
		key.kty !== "RSA" ||
		key.use !== "sig" ||
		key.alg !== "RS256" ||
		typeof key.kid !== "string" ||
		!key.kid ||
		typeof key.n !== "string" ||
		typeof key.e !== "string" ||
		["d", "p", "q", "dp", "dq", "qi", "oth"].some(name => name in key)
	) {
		fail("JWT JWKS contains an invalid or private key");
	}
	if (keyIds.has(key.kid)) fail("JWT JWKS contains a duplicate kid");
	keyIds.add(key.kid);
}

const activeKid = process.env.IDENTITY_JWT_ACCESS_ACTIVE_KID;
const activeJwk = jwks.keys.find(key => key.kid === activeKid);
if (!activeJwk) fail("JWT active kid is missing from JWKS");

let publicKey;
try {
	publicKey = createPublicKey({ key: activeJwk, format: "jwk" });
} catch {
	fail("JWT active public JWK is malformed");
}
if ((publicKey.asymmetricKeyDetails?.modulusLength || 0) < 3072) {
	fail("JWT active public key must be at least 3072 bits");
}

const challenge = randomBytes(64);
const signature = sign("sha256", challenge, privateKey);
if (!verify("sha256", challenge, publicKey, signature)) {
	fail("JWT private key does not match the active public JWK");
}

process.stdout.write(`Identity JWT RS256 keyset validated for kid ${activeKid}\n`);
'

rabbitmq_admin_user="$(get_env_value "RABBITMQ_ADMIN_USER")"
rabbitmq_admin_password="$(get_env_value "RABBITMQ_ADMIN_PASSWORD")"
rabbitmq_monitor_user="$(get_env_value "RABBITMQ_MONITOR_USER")"
rabbitmq_monitor_password="$(get_env_value "RABBITMQ_MONITOR_PASSWORD")"

validate_rabbitmq_username() {
	local variable_name="$1"
	local username="$2"

	if [[ ! "$username" =~ ^[A-Za-z0-9._-]+$ ]]; then
		echo "$variable_name must contain only letters, digits, dot, underscore or hyphen" >&2
		exit 1
	fi
}

validate_rabbitmq_username "RABBITMQ_ADMIN_USER" "$rabbitmq_admin_user"
validate_rabbitmq_username "RABBITMQ_MONITOR_USER" "$rabbitmq_monitor_user"
if [[ ! "$rabbitmq_vhost" =~ ^[A-Za-z0-9._/-]+$ ]]; then
	echo "RABBITMQ_VHOST contains unsupported characters" >&2
	exit 1
fi
if [[ "$rabbitmq_admin_password" == change_me* ||
	"$rabbitmq_monitor_password" == change_me* ||
	${#rabbitmq_admin_password} -lt 32 ||
	${#rabbitmq_monitor_password} -lt 32 ]]; then
	echo "RabbitMQ admin and monitor passwords must be non-example values of at least 32 characters" >&2
	exit 1
fi

parse_rabbitmq_service_url() {
	local variable_name="$1"
	local url_value
	local parsed
	local encoded_user
	local encoded_password
	local encoded_vhost

	url_value="$(get_env_value "$variable_name")"
	if ! parsed="$(
		printf '%s' "$url_value" |
			docker run --rm -i --network none \
				--entrypoint node \
				-e "RABBITMQ_EXPECTED_VHOST=$rabbitmq_vhost" \
				"winwidget-api:$APP_VERSION" \
				-e '
const { readFileSync } = require("node:fs");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let url;
try {
	url = new URL(readFileSync(0, "utf8"));
} catch {
	fail("RabbitMQ service URL is invalid");
}

if (url.protocol !== "amqp:") {
	fail("RabbitMQ service URL must use amqp for the local production broker");
}
if (!url.hostname || url.search || url.hash) {
	fail("RabbitMQ service URL must contain a host and no query or fragment");
}
if (url.hostname !== "127.0.0.1" || (url.port && url.port !== "5672")) {
	fail("RabbitMQ service URL must target 127.0.0.1:5672");
}

let username;
let password;
let vhost;
try {
	username = decodeURIComponent(url.username);
	password = decodeURIComponent(url.password);
	vhost = decodeURIComponent(url.pathname.slice(1));
} catch {
	fail("RabbitMQ service URL contains invalid percent-encoding");
}

if (!/^[A-Za-z0-9._-]+$/.test(username)) {
	fail("RabbitMQ service username contains unsupported characters");
}
if (
	password.length < 32 ||
	password.startsWith("change_me") ||
	/[\0\r\n]/.test(password)
) {
	fail("RabbitMQ service password is missing or unsafe");
}
if (vhost !== process.env.RABBITMQ_EXPECTED_VHOST) {
	fail("RabbitMQ service URL vhost does not match RABBITMQ_VHOST");
}

for (const value of [username, password, vhost]) {
	process.stdout.write(`${Buffer.from(value).toString("base64")}\n`);
}
'
	)"; then
		echo "$variable_name is invalid" >&2
		exit 1
	fi

	encoded_user="$(sed -n '1p' <<<"$parsed")"
	encoded_password="$(sed -n '2p' <<<"$parsed")"
	encoded_vhost="$(sed -n '3p' <<<"$parsed")"
	if [[ -z "$encoded_user" || -z "$encoded_password" || -z "$encoded_vhost" ]]; then
		echo "$variable_name could not be parsed safely" >&2
		exit 1
	fi

	printf '%s\n%s\n%s\n' \
		"$encoded_user" "$encoded_password" "$encoded_vhost"
}

publisher_credentials="$(parse_rabbitmq_service_url "RABBITMQ_PUBLISHER_URL")"
integration_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_INTEGRATION_WORKER_URL"
)"
maintenance_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_MAINTENANCE_WORKER_URL"
)"
notification_delivery_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_NOTIFICATION_DELIVERY_URL"
)"
campaigns_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_CAMPAIGNS_URL"
)"
reporting_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_REPORTING_URL"
)"
widgets_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_WIDGETS_URL"
)"
billing_worker_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_BILLING_WORKER_URL"
)"
billing_publisher_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_BILLING_PUBLISHER_URL"
)"
identity_worker_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_IDENTITY_WORKER_URL"
)"
identity_publisher_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_IDENTITY_PUBLISHER_URL"
)"
support_worker_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_SUPPORT_WORKER_URL"
)"
support_publisher_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_SUPPORT_PUBLISHER_URL"
)"

publisher_user="$(
	printf '%s' "$(sed -n '1p' <<<"$publisher_credentials")" | base64 --decode
)"
publisher_password_base64="$(sed -n '2p' <<<"$publisher_credentials")"
integration_user="$(
	printf '%s' "$(sed -n '1p' <<<"$integration_credentials")" | base64 --decode
)"
integration_password_base64="$(sed -n '2p' <<<"$integration_credentials")"
maintenance_user="$(
	printf '%s' "$(sed -n '1p' <<<"$maintenance_credentials")" | base64 --decode
)"
maintenance_password_base64="$(sed -n '2p' <<<"$maintenance_credentials")"
notification_delivery_user="$(
	printf '%s' \
		"$(sed -n '1p' <<<"$notification_delivery_credentials")" |
		base64 --decode
)"
notification_delivery_password_base64="$(
	sed -n '2p' <<<"$notification_delivery_credentials"
)"
campaigns_user="$(
	printf '%s' "$(sed -n '1p' <<<"$campaigns_credentials")" |
		base64 --decode
)"
campaigns_password_base64="$(sed -n '2p' <<<"$campaigns_credentials")"
reporting_user="$(
	printf '%s' "$(sed -n '1p' <<<"$reporting_credentials")" |
		base64 --decode
)"
reporting_password_base64="$(sed -n '2p' <<<"$reporting_credentials")"
if [[ "$reporting_user" != "winwidget-reporting" ]]; then
	echo "RABBITMQ_REPORTING_URL must use the dedicated winwidget-reporting user" >&2
	exit 1
fi
widgets_user="$(
	printf '%s' "$(sed -n '1p' <<<"$widgets_credentials")" |
		base64 --decode
)"
widgets_password_base64="$(sed -n '2p' <<<"$widgets_credentials")"
if [[ "$widgets_user" != "winwidget-widgets" ]]; then
	echo "RABBITMQ_WIDGETS_URL must use the dedicated winwidget-widgets user" >&2
	exit 1
fi
billing_worker_user="$(
	printf '%s' "$(sed -n '1p' <<<"$billing_worker_credentials")" |
		base64 --decode
)"
billing_worker_password_base64="$(sed -n '2p' <<<"$billing_worker_credentials")"
billing_publisher_user="$(
	printf '%s' "$(sed -n '1p' <<<"$billing_publisher_credentials")" |
		base64 --decode
)"
billing_publisher_password_base64="$(sed -n '2p' <<<"$billing_publisher_credentials")"
if [[ "$billing_worker_user" != 'winwidget-billing-worker' ||
	"$billing_publisher_user" != 'winwidget-billing-publisher' ]]; then
	echo 'Billing RabbitMQ URLs must use the two dedicated canonical users.' >&2
	exit 1
fi
identity_worker_user="$(
	printf '%s' "$(sed -n '1p' <<<"$identity_worker_credentials")" |
		base64 --decode
)"
identity_worker_password_base64="$(sed -n '2p' <<<"$identity_worker_credentials")"
identity_publisher_user="$(
	printf '%s' "$(sed -n '1p' <<<"$identity_publisher_credentials")" |
		base64 --decode
)"
identity_publisher_password_base64="$(sed -n '2p' <<<"$identity_publisher_credentials")"
if [[ "$identity_worker_user" != 'winwidget-identity-worker' ||
	"$identity_publisher_user" != 'winwidget-identity-publisher' ]]; then
	echo 'Identity RabbitMQ URLs must use the two dedicated canonical users.' >&2
	exit 1
fi
support_worker_user="$(
	printf '%s' "$(sed -n '1p' <<<"$support_worker_credentials")" |
		base64 --decode
)"
support_worker_password_base64="$(sed -n '2p' <<<"$support_worker_credentials")"
support_publisher_user="$(
	printf '%s' "$(sed -n '1p' <<<"$support_publisher_credentials")" |
		base64 --decode
)"
support_publisher_password_base64="$(sed -n '2p' <<<"$support_publisher_credentials")"
if [[ "$support_worker_user" != 'winwidget-support-worker' ||
	"$support_publisher_user" != 'winwidget-support-publisher' ]]; then
	echo 'Support RabbitMQ URLs must use the two dedicated canonical users.' >&2
	exit 1
fi
rabbitmq_admin_password_base64="$(
	printf '%s' "$rabbitmq_admin_password" | base64 | tr -d '\n'
)"
rabbitmq_monitor_password_base64="$(
	printf '%s' "$rabbitmq_monitor_password" | base64 | tr -d '\n'
)"

service_users=(
	"$rabbitmq_admin_user"
	"$rabbitmq_monitor_user"
	"$publisher_user"
	"$integration_user"
	"$maintenance_user"
	"$notification_delivery_user"
	"$campaigns_user"
	"$reporting_user"
	"$widgets_user"
	"$billing_worker_user"
	"$billing_publisher_user"
	"$identity_worker_user"
	"$identity_publisher_user"
	"$support_worker_user"
	"$support_publisher_user"
)
for ((left = 0; left < ${#service_users[@]}; left++)); do
	for ((right = left + 1; right < ${#service_users[@]}; right++)); do
		if [[ "${service_users[$left]}" == "${service_users[$right]}" ]]; then
			echo "RabbitMQ admin, monitor and service URLs must use distinct users" >&2
			exit 1
		fi
	done
done

if [[ -n "$matched_rabbitmq_container_id" ]]; then
	rabbitmq_is_running="$(
		docker inspect --format '{{ .State.Running }}' \
			"$matched_rabbitmq_container_id"
	)"
	if [[ "$rabbitmq_is_running" != "true" ]]; then
		docker start "$matched_rabbitmq_container_id" >/dev/null
	fi
	provisioning_rabbitmq_container_id="$matched_rabbitmq_container_id"
else
	compose_target up -d rabbitmq
	provisioning_rabbitmq_container_id="$(compose_target ps -q rabbitmq)"
fi

if [[ -z "$provisioning_rabbitmq_container_id" ]]; then
	echo "RabbitMQ container for service-user provisioning was not found" >&2
	exit 1
fi

for ((attempt = 1; attempt <= 30; attempt++)); do
	if docker exec "$provisioning_rabbitmq_container_id" \
		rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
		break
	fi
	if ((attempt == 30)); then
		echo "RabbitMQ did not become ready for service-user provisioning" >&2
		exit 1
	fi
	sleep 2
done

RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	docker exec \
		-e RABBITMQ_PROVISION_VHOST \
		"$provisioning_rabbitmq_container_id" \
		sh -ec '
if ! rabbitmqctl --silent list_vhosts name |
	grep -Fqx -- "$RABBITMQ_PROVISION_VHOST"; then
	rabbitmqctl add_vhost "$RABBITMQ_PROVISION_VHOST"
fi
'

unexpected_broad_users="$(
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_PROVISION_ADMIN_USER="$rabbitmq_admin_user" \
		docker exec \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_PROVISION_ADMIN_USER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
permissions="$(
	rabbitmqctl --silent list_permissions \
		-p "$RABBITMQ_PROVISION_VHOST" --no-table-headers
)"
printf "%s\n" "$permissions" |
awk -v admin="$RABBITMQ_PROVISION_ADMIN_USER" \
	'\''$2 == ".*" && $3 == ".*" && $4 == ".*" &&
		$1 != admin { print $1 }'\''
'
)"
if [[ -n "$unexpected_broad_users" ]]; then
	echo "Unexpected broad RabbitMQ user(s) on vhost $rabbitmq_vhost:" >&2
	echo "$unexpected_broad_users" >&2
	exit 1
fi

provision_rabbitmq_user() {
	local username="$1"
	local password_base64="$2"
	local configure_pattern="$3"
	local write_pattern="$4"
	local read_pattern="$5"
	local tag="$6"

	if ! RABBITMQ_ADMIN_USER="$rabbitmq_admin_user" \
		RABBITMQ_ADMIN_PASSWORD="$rabbitmq_admin_password" \
		RABBITMQ_MANAGEMENT_URL="$rabbitmq_management_url" \
		RABBITMQ_PROVISION_USER="$username" \
		RABBITMQ_PROVISION_PASSWORD_BASE64="$password_base64" \
		RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
		RABBITMQ_PROVISION_TAG="$tag" \
		docker run --rm --network host --read-only \
			--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 \
			--cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
			--log-driver none \
			--env RABBITMQ_ADMIN_USER \
			--env RABBITMQ_ADMIN_PASSWORD \
			--env RABBITMQ_MANAGEMENT_URL \
			--env RABBITMQ_PROVISION_USER \
			--env RABBITMQ_PROVISION_PASSWORD_BASE64 \
			--env RABBITMQ_PROVISION_VHOST \
			--env RABBITMQ_PROVISION_TAG \
			--entrypoint node \
			"winwidget-api:$APP_VERSION" \
			-e '
const amqp = require("amqplib");

const required = [
  "RABBITMQ_ADMIN_USER",
  "RABBITMQ_ADMIN_PASSWORD",
  "RABBITMQ_MANAGEMENT_URL",
  "RABBITMQ_PROVISION_USER",
  "RABBITMQ_PROVISION_PASSWORD_BASE64",
  "RABBITMQ_PROVISION_VHOST",
  "RABBITMQ_PROVISION_TAG",
];
const value = name => process.env[name] ?? "";
const invalid = () => {
  throw new Error("invalid RabbitMQ provisioning input");
};

(async () => {
	if (required.slice(0, -1).some(name => !value(name))) invalid();
	if (value("RABBITMQ_MANAGEMENT_URL") !== "http://127.0.0.1:15672") invalid();
	if (![value("RABBITMQ_ADMIN_USER"), value("RABBITMQ_PROVISION_USER")]
		.every(username => /^[A-Za-z0-9._-]+$/.test(username))) invalid();
	if (!/^[A-Za-z0-9._/-]+$/.test(value("RABBITMQ_PROVISION_VHOST"))) invalid();
	if (!/^(?:[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)?$/.test(value("RABBITMQ_PROVISION_TAG"))) invalid();

	const encodedPassword = value("RABBITMQ_PROVISION_PASSWORD_BASE64");
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedPassword)) invalid();
	const targetPassword = Buffer.from(encodedPassword, "base64").toString("utf8");
	if (Buffer.from(targetPassword, "utf8").toString("base64") !== encodedPassword ||
		targetPassword.length < 32 || /[\0\r\n]/.test(targetPassword)) invalid();
	if (value("RABBITMQ_ADMIN_PASSWORD").length < 32 ||
		/[\0\r\n]/.test(value("RABBITMQ_ADMIN_PASSWORD"))) invalid();

	const connectRabbitMq = async (username, password, connectionName) => {
		const connection = await amqp.connect({
			protocol: "amqp",
			hostname: "127.0.0.1",
			port: 5672,
			username,
			password,
			vhost: value("RABBITMQ_PROVISION_VHOST"),
			clientProperties: { connection_name: connectionName },
		}, { timeout: 10_000 });
		await connection.close();
	};

  const adminConnection = await connectRabbitMq(
    value("RABBITMQ_ADMIN_USER"),
    value("RABBITMQ_ADMIN_PASSWORD"),
    "winwidget-routine-deploy-admin-credential-check",
  );
  void adminConnection;

  const authorization = `Basic ${Buffer.from(
    `${value("RABBITMQ_ADMIN_USER")}:${value("RABBITMQ_ADMIN_PASSWORD")}`,
  ).toString("base64")}`;
  const response = await fetch(
    `${value("RABBITMQ_MANAGEMENT_URL")}/api/users/${encodeURIComponent(value("RABBITMQ_PROVISION_USER"))}`,
    {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        password: targetPassword,
        tags: value("RABBITMQ_PROVISION_TAG"),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (![201, 204].includes(response.status)) {
    throw new Error("RabbitMQ Management API rejected the user update");
  }

  const targetConnection = await connectRabbitMq(
    value("RABBITMQ_PROVISION_USER"),
    targetPassword,
    "winwidget-routine-deploy-target-credential-check",
  );
  void targetConnection;
})().catch(() => {
  process.stderr.write("RabbitMQ credential provisioning failed\n");
  process.exitCode = 1;
});
'; then
		echo 'RabbitMQ credential provisioning failed before permissions were changed.' >&2
		return 1
	fi

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_PROVISION_CONFIGURE="$configure_pattern" \
	RABBITMQ_PROVISION_WRITE="$write_pattern" \
	RABBITMQ_PROVISION_READ="$read_pattern" \
		docker exec \
			--env RABBITMQ_PROVISION_USER \
			--env RABBITMQ_PROVISION_VHOST \
			--env RABBITMQ_PROVISION_CONFIGURE \
			--env RABBITMQ_PROVISION_WRITE \
			--env RABBITMQ_PROVISION_READ \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '

while IFS= read -r other_vhost; do
	if [ "$other_vhost" != "$RABBITMQ_PROVISION_VHOST" ]; then
		rabbitmqctl clear_permissions \
			-p "$other_vhost" "$RABBITMQ_PROVISION_USER"
		rabbitmqctl clear_topic_permissions \
			-p "$other_vhost" "$RABBITMQ_PROVISION_USER"
	fi
done <<EOF
$(rabbitmqctl --silent list_vhosts name)
EOF

rabbitmqctl set_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"$RABBITMQ_PROVISION_CONFIGURE" \
	"$RABBITMQ_PROVISION_WRITE" \
	"$RABBITMQ_PROVISION_READ"
'
}

provision_campaigns_rabbitmq_topic_permissions() {
	local username="$1"
	local events_write_pattern
	local events_read_pattern
	local dead_letter_pattern
	events_write_pattern='^(admin\.audit\.event\.v1|campaign\.snapshot\.requested\.v1|notification\.campaign\.(email|telegram)\.requested\.v2|notification\.delivery\.outcome\.v2)$'
	events_read_pattern='^(campaign\.snapshot\.requested\.v1|notification\.delivery\.outcome\.v2)$'
	dead_letter_pattern='^campaigns\.(snapshot|outcome)\.dead-letter$'

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_CAMPAIGNS_EVENTS_WRITE="$events_write_pattern" \
	RABBITMQ_CAMPAIGNS_EVENTS_READ="$events_read_pattern" \
	RABBITMQ_CAMPAIGNS_DEAD_LETTER="$dead_letter_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_CAMPAIGNS_EVENTS_WRITE \
			-e RABBITMQ_CAMPAIGNS_EVENTS_READ \
			-e RABBITMQ_CAMPAIGNS_DEAD_LETTER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
rabbitmqctl clear_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.events" \
	"$RABBITMQ_CAMPAIGNS_EVENTS_WRITE" \
	"$RABBITMQ_CAMPAIGNS_EVENTS_READ"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.dead-letter" \
	"$RABBITMQ_CAMPAIGNS_DEAD_LETTER" \
	"$RABBITMQ_CAMPAIGNS_DEAD_LETTER"
'
}

provision_reporting_rabbitmq_topic_permissions() {
	local username="$1"
	local mode="${2:-steady}"
	local events_write_pattern
	local events_read_pattern
	local dead_letter_pattern
	events_write_pattern='^(notification\.daily-summary\.telegram\.requested\.v1|admin\.audit\.reporting\.v1)$'
	case "$mode" in
	transition)
		events_read_pattern='^(identity\.user\.changed\.v1|billing\.(payment|subscription)\.changed\.v1|widgets\.(widget|lead)\.changed\.v1|reporting\.(settings|core-operational-routing)\.changed\.v1|notification\.delivery\.outcome\.v1|reporting\.notification\.delivery\.outcome\.v1)$'
		;;
	steady)
		events_read_pattern='^(identity\.user\.changed\.v1|billing\.(payment|subscription)\.changed\.v1|widgets\.(widget|lead)\.changed\.v1|reporting\.(settings|core-operational-routing)\.changed\.v1|reporting\.notification\.delivery\.outcome\.v1)$'
		;;
	*)
		echo "Unsupported Reporting topic permission mode: $mode" >&2
		return 1
		;;
	esac
	dead_letter_pattern='^reporting\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\.dead-letter$'

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_REPORTING_EVENTS_WRITE="$events_write_pattern" \
	RABBITMQ_REPORTING_EVENTS_READ="$events_read_pattern" \
	RABBITMQ_REPORTING_DEAD_LETTER="$dead_letter_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_REPORTING_EVENTS_WRITE \
			-e RABBITMQ_REPORTING_EVENTS_READ \
			-e RABBITMQ_REPORTING_DEAD_LETTER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
rabbitmqctl clear_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.events" \
	"$RABBITMQ_REPORTING_EVENTS_WRITE" \
	"$RABBITMQ_REPORTING_EVENTS_READ"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.dead-letter" \
	"$RABBITMQ_REPORTING_DEAD_LETTER" \
	"$RABBITMQ_REPORTING_DEAD_LETTER"
'
}

provision_widgets_rabbitmq_topic_permissions() {
	local username="$1"
	local events_write_pattern
	local events_read_pattern
	local dead_letter_pattern
	events_write_pattern="$WIDGETS_CANONICAL_EVENTS_TOPIC_WRITE"
	events_read_pattern="$WIDGETS_CANONICAL_EVENTS_TOPIC_READ"
	dead_letter_pattern="$WIDGETS_CANONICAL_DEAD_LETTER_TOPIC"

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_WIDGETS_EVENTS_WRITE="$events_write_pattern" \
	RABBITMQ_WIDGETS_EVENTS_READ="$events_read_pattern" \
	RABBITMQ_WIDGETS_DEAD_LETTER="$dead_letter_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_WIDGETS_EVENTS_WRITE \
			-e RABBITMQ_WIDGETS_EVENTS_READ \
			-e RABBITMQ_WIDGETS_DEAD_LETTER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_PROVISION_USER" \
	"winwidget.events" "$RABBITMQ_WIDGETS_EVENTS_WRITE" "$RABBITMQ_WIDGETS_EVENTS_READ"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_PROVISION_USER" \
	"winwidget.dead-letter" "$RABBITMQ_WIDGETS_DEAD_LETTER" "$RABBITMQ_WIDGETS_DEAD_LETTER"
'
}

provision_billing_rabbitmq_topic_permissions() {
	local worker_user="$1" publisher_user="$2"
	local worker_read publisher_write
	worker_read='^(billing\.identity\.changed\.v1|billing\.notification-routing\.changed\.v1|billing\.trial\.requested\.v1|billing\.referral\.requested\.v1|billing\.offer\.changed\.v2|billing\.lifecycle-repair\.requested\.v1|payment\.auto-renewal\.charge\.requested\.v1|notification\.delivery\.outcome\.v1)$'
	publisher_write='^(payment\.succeeded\.v1|payment\.notification\.telegram\.requested\.v1|payment\.auto-renewal\.charge\.requested\.v1|notification\.subscription-expiry\.(email|telegram)\.requested\.v1|billing\.(payment|subscription)(\.details)?\.changed\.v1|billing\.(affiliate|settings)\.changed\.v1|admin\.audit\.billing\.v1)$'
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_BILLING_WORKER_USER="$worker_user" \
	RABBITMQ_BILLING_PUBLISHER_USER="$publisher_user" \
	RABBITMQ_BILLING_WORKER_TOPIC_READ="$worker_read" \
	RABBITMQ_BILLING_PUBLISHER_TOPIC_WRITE="$publisher_write" \
		docker exec \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_BILLING_WORKER_USER \
			-e RABBITMQ_BILLING_PUBLISHER_USER \
			-e RABBITMQ_BILLING_WORKER_TOPIC_READ \
			-e RABBITMQ_BILLING_PUBLISHER_TOPIC_WRITE \
			"$provisioning_rabbitmq_container_id" sh -euc '
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_BILLING_WORKER_USER"
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_BILLING_PUBLISHER_USER"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_BILLING_WORKER_USER" winwidget.events "^$" \
	"$RABBITMQ_BILLING_WORKER_TOPIC_READ"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_BILLING_PUBLISHER_USER" winwidget.events \
	"$RABBITMQ_BILLING_PUBLISHER_TOPIC_WRITE" "^$"
'
}

provision_identity_rabbitmq_topic_permissions() {
	local worker_user="$1" publisher_user="$2"
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_IDENTITY_WORKER_USER="$worker_user" \
	RABBITMQ_IDENTITY_PUBLISHER_USER="$publisher_user" \
		docker exec \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_IDENTITY_WORKER_USER \
			-e RABBITMQ_IDENTITY_PUBLISHER_USER \
			"$provisioning_rabbitmq_container_id" sh -euc '
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_IDENTITY_WORKER_USER"
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_IDENTITY_PUBLISHER_USER"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_IDENTITY_WORKER_USER" winwidget.events "^$" \
  "^(notification\.telegram\.destination-unavailable\.v1|manual\.telegram-destination-unavailable|telegram-destination-unavailable\.dead-letter)$"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_IDENTITY_WORKER_USER" winwidget.dead-letter "^$" \
  "^telegram-destination-unavailable\.dead-letter$"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_IDENTITY_PUBLISHER_USER" winwidget.events \
  "^(identity\.user\.changed\.v1|billing\.(identity\.changed|referral\.requested|lifecycle-repair\.requested)\.v1|admin\.audit\.identity\.v1)$" "^$"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_IDENTITY_PUBLISHER_USER" winwidget.dead-letter \
  "^telegram-destination-unavailable\.dead-letter$" "^$"
'
}

provision_support_rabbitmq_topic_permissions() {
	local worker_user="$1" publisher_user="$2"
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_SUPPORT_WORKER_USER="$worker_user" \
	RABBITMQ_SUPPORT_PUBLISHER_USER="$publisher_user" \
		docker exec \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_SUPPORT_WORKER_USER \
			-e RABBITMQ_SUPPORT_PUBLISHER_USER \
			"$provisioning_rabbitmq_container_id" sh -euc '
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_SUPPORT_WORKER_USER"
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_SUPPORT_PUBLISHER_USER"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_SUPPORT_WORKER_USER" winwidget.events "^$" \
  "^support\.telegram\.webhook-admitted\.v1$"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_SUPPORT_PUBLISHER_USER" winwidget.events \
  "^(support\.telegram\.webhook-admitted\.v1|admin\.audit\.support\.v1)$" "^$"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_SUPPORT_PUBLISHER_USER" winwidget.dead-letter \
  "^support-telegram-webhook\.dead-letter$" "^$"
'
}

assert_campaigns_shared_rabbitmq_topology() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"$CAMPAIGNS_IMAGE" \
		-e '
const amqp = require("amqplib");
const {
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE,
} = require("./dist/src/messaging/campaigns-messaging.constants.js");

(async () => {
	const connection = await amqp.connect(process.env.RABBITMQ_PUBLISHER_URL);
	try {
		const channel = await connection.createConfirmChannel();
		try {
			await channel.assertExchange(EVENTS_EXCHANGE, "topic", {
				durable: true,
			});
			await channel.assertExchange(DEAD_LETTER_EXCHANGE, "topic", {
				durable: true,
			});
		} finally {
			await channel.close();
		}
	} finally {
		await connection.close();
	}
	process.stdout.write("Shared Campaigns RabbitMQ exchanges verified\n");
})().catch(error => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Shared RabbitMQ topology assertion failed"}\n`,
	);
	process.exitCode = 1;
});
'
}

assert_reporting_shared_rabbitmq_topology() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"$REPORTING_IMAGE" \
		-e '
const amqp = require("amqplib");
const {
	REPORTING_DEAD_LETTER_EXCHANGE,
	REPORTING_EVENTS_EXCHANGE,
} = require("./dist/src/messaging/reporting-messaging.constants.js");

(async () => {
	const connection = await amqp.connect(process.env.RABBITMQ_PUBLISHER_URL);
	try {
		const channel = await connection.createConfirmChannel();
		try {
			await channel.assertExchange(REPORTING_EVENTS_EXCHANGE, "topic", {
				durable: true,
			});
			await channel.assertExchange(REPORTING_DEAD_LETTER_EXCHANGE, "topic", {
				durable: true,
			});
		} finally {
			await channel.close();
		}
	} finally {
		await connection.close();
	}
	process.stdout.write("Shared Reporting RabbitMQ exchanges verified\n");
})().catch(error => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Shared Reporting RabbitMQ topology assertion failed"}\n`,
	);
	process.exitCode = 1;
});
'
}

provision_rabbitmq_user \
	"$rabbitmq_admin_user" \
	"$rabbitmq_admin_password_base64" \
	'.*' \
	'.*' \
	'.*' \
	'administrator'
provision_rabbitmq_user \
	"$publisher_user" \
	"$publisher_password_base64" \
	'^winwidget\..*' \
	'^winwidget\..*' \
	'^winwidget\..*' \
	''
assert_campaigns_shared_rabbitmq_topology
assert_reporting_shared_rabbitmq_topology
post_cutover_integration_read_pattern='^winwidget\.(payment\.auto-renewal|admin\.audit\.(campaigns|reporting|widgets|billing)\.v1|core\.billing\.(payment-details|subscription-details|affiliate)\.v1|notification\.(telegram-destination-unavailable|delivery-outcome))(\..*)?$'
post_billing_integration_read_pattern='^winwidget\.(admin\.audit\.(campaigns|reporting|widgets|billing)\.v1|core\.billing\.(payment-details|subscription-details|affiliate)\.v1|notification\.telegram-destination-unavailable)(\..*)?$'
post_identity_integration_read_pattern='^winwidget\.(admin\.audit\.(campaigns|reporting|widgets|billing|identity|platform|support)\.v1|core\.billing\.(payment-details|subscription-details|affiliate)\.v1)(\.dead-letter)?$'
legacy_integration_read_pattern='^winwidget\.(lead-integration\.(webhook|bitrix24|amo-crm)|payment\.auto-renewal|payment-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|mailing\..*|limit-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|admin\.audit\.campaigns\.v1|report\.daily-summary\.telegram)(\..*)?$'
integration_worker_read_pattern="$post_cutover_integration_read_pattern"
if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	integration_worker_read_pattern="$legacy_integration_read_pattern"
elif [[ "$identity_database_phase" == 'complete' ]]; then
	integration_worker_read_pattern="$post_identity_integration_read_pattern"
elif [[ "$billing_database_phase" == 'active' ||
	"$billing_database_phase" == 'complete' ]]; then
	integration_worker_read_pattern="$post_billing_integration_read_pattern"
fi
provision_rabbitmq_user \
	"$integration_user" \
	"$integration_password_base64" \
	'^$' \
	'^(winwidget\.retry|winwidget\.dead-letter)$' \
	"$integration_worker_read_pattern" \
	''
provision_rabbitmq_user \
	"$maintenance_user" \
	"$maintenance_password_base64" \
	'^$' \
	'^(winwidget\.retry|winwidget\.dead-letter)$' \
	'^winwidget\.maintenance\..*' \
	''
provision_rabbitmq_user \
	"$notification_delivery_user" \
	"$notification_delivery_password_base64" \
	'^$' \
	'^(winwidget\.events|winwidget\.dead-letter)$' \
	'^winwidget\.(lead-integration\.(email|telegram)|payment-notification\.(email|telegram\.v2)|limit-notification\.(email|telegram)|notification\.(campaign\.(email|telegram)|daily-summary\.telegram|subscription-expiry\.(email|telegram)))(\..*)?$' \
	''
provision_rabbitmq_user \
	"$campaigns_user" \
	"$campaigns_password_base64" \
	'^winwidget\.campaigns(\..*)?$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.campaigns(\..*)?)$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.campaigns(\..*)?)$' \
	''
provision_campaigns_rabbitmq_topic_permissions "$campaigns_user"
provision_rabbitmq_user \
	"$reporting_user" \
	"$reporting_password_base64" \
	'^winwidget\.reporting(\..*)?$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$' \
	''
initial_reporting_outcome_route_state="$(
	reporting_outcome_route_topology_state
)"
if [[ "$initial_reporting_outcome_route_state" == 'steady' ]]; then
	provision_reporting_rabbitmq_topic_permissions "$reporting_user" steady
else
	provision_reporting_rabbitmq_topic_permissions "$reporting_user" transition
fi
provision_rabbitmq_user \
	"$widgets_user" \
	"$widgets_password_base64" \
	"$WIDGETS_CANONICAL_RABBITMQ_CONFIGURE_PATTERN" \
	"$WIDGETS_CANONICAL_RABBITMQ_WRITE_PATTERN" \
	"$WIDGETS_CANONICAL_RABBITMQ_READ_PATTERN" \
	''
provision_widgets_rabbitmq_topic_permissions "$widgets_user"
provision_rabbitmq_user \
	"$billing_worker_user" \
	"$billing_worker_password_base64" \
	'^winwidget\.(billing\.(retry|dead-letter)|billing\.(identity|notification-routing|trial|referral|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.offer\.v2(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$' \
	'^winwidget\.(billing\.(retry|dead-letter)|billing\.(identity|notification-routing|trial|referral|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.offer\.v2(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$' \
	'^winwidget\.(events|billing\.(retry|dead-letter)|billing\.(identity|notification-routing|trial|referral|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.offer\.v2(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$' \
	''
	provision_rabbitmq_user \
		"$billing_publisher_user" \
		"$billing_publisher_password_base64" \
		'^$' \
		'^winwidget\.(events|billing\.(retry|dead-letter))$' \
		'^$' \
		''
provision_billing_rabbitmq_topic_permissions \
	"$billing_worker_user" "$billing_publisher_user"
provision_rabbitmq_user \
	"$identity_worker_user" \
	"$identity_worker_password_base64" \
	'^(winwidget\.(events|retry|dead-letter|manual-retry)|winwidget\.notification\.telegram-destination-unavailable(\.dead-letter|\.retry-v2\.[123])?)$' \
	'^(winwidget\.(retry|dead-letter|manual-retry)|winwidget\.notification\.telegram-destination-unavailable(\.dead-letter|\.retry-v2\.[123])?)$' \
	'^(winwidget\.(events|retry|dead-letter|manual-retry)|winwidget\.notification\.telegram-destination-unavailable(\.dead-letter|\.retry-v2\.[123])?)$' \
	''
provision_rabbitmq_user \
	"$identity_publisher_user" \
	"$identity_publisher_password_base64" \
	'^$' \
	'^winwidget\.(events|retry|dead-letter|manual-retry)$' \
	'^$' \
	''
provision_identity_rabbitmq_topic_permissions \
	"$identity_worker_user" "$identity_publisher_user"
provision_rabbitmq_user \
	"$support_worker_user" \
	"$support_worker_password_base64" \
	'^(winwidget\.(events|retry|dead-letter|manual-retry)|winwidget\.support\.telegram-webhook\.v1(\.retry-v2\.[123]|\.dead-letter)?)$' \
	'^winwidget\.(events|retry|dead-letter|manual-retry)$' \
	'^(winwidget\.(events|retry|dead-letter|manual-retry)|winwidget\.support\.telegram-webhook\.v1(\.retry-v2\.[123]|\.dead-letter)?)$' \
	''
provision_rabbitmq_user \
	"$support_publisher_user" \
	"$support_publisher_password_base64" \
	'^$' \
	'^winwidget\.(events|retry|dead-letter|manual-retry)$' \
	'^$' \
	''
provision_support_rabbitmq_topic_permissions \
	"$support_worker_user" "$support_publisher_user"
provision_rabbitmq_user \
	"$rabbitmq_monitor_user" \
	"$rabbitmq_monitor_password_base64" \
	'^$' \
	'^$' \
	'^$' \
	'monitoring'

echo "RabbitMQ admin/service users and least-privilege permissions are verified"

assert_cutover_rabbitmq_topology() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		-e RABBITMQ_ASSERT_TOPOLOGY=true \
		-e RABBITMQ_CONNECTION_NAME=winwidget-notification-telegram-cutover-topology \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const {
	RabbitMqService,
} = require("./dist/src/messaging/rabbitmq.service.js");

const configService = {
	get(key) {
		if (key === "RABBITMQ_URL") {
			return process.env.RABBITMQ_PUBLISHER_URL;
		}
		return process.env[key];
	},
};
const rabbitMq = new RabbitMqService(configService);

rabbitMq
	.onModuleInit()
	.then(async () => {
		process.stdout.write(
			"Telegram ownership cutover RabbitMQ topology asserted\n",
		);
		await rabbitMq.onApplicationShutdown();
	})
	.catch(async error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "RabbitMQ topology assertion failed"}\n`,
		);
		try {
			await rabbitMq.onApplicationShutdown();
		} catch {}
		process.exitCode = 1;
	});
'
}

wait_for_rabbitmq_topology() {
	local rabbitmq_container_id
	local required_queues
	local campaigns_required_queues
	local widgets_required_queues
	local actual_queues
	local required_queue
	local all_ready
	local attempt

	rabbitmq_container_id="$(compose_target ps --status running -q rabbitmq)"
	if [[ -z "$rabbitmq_container_id" ]]; then
		echo "RabbitMQ is not running while waiting for topology" >&2
		return 1
	fi
	required_queues="$(
		docker run --rm --network none \
			--entrypoint node \
			"winwidget-api:$APP_VERSION" \
			-e '
const {
	CORE_RABBITMQ_TOPOLOGY_KINDS,
	MESSAGING_QUEUE_NAMES
} = require("./dist/src/messaging/messaging.constants.js");
for (const kind of CORE_RABBITMQ_TOPOLOGY_KINDS) {
	const queue = MESSAGING_QUEUE_NAMES[kind];
	process.stdout.write(`${queue}\n${queue}.dead-letter\n`);
}
'
	)"
	campaigns_required_queues="$(
		docker run --rm --network none \
			--entrypoint node \
			"$CAMPAIGNS_IMAGE" \
			-e '
const {
	CAMPAIGNS_CONSUMER_KINDS,
	CAMPAIGNS_QUEUE_NAMES,
	CAMPAIGNS_RETRY_DELAYS_MS,
} = require("./dist/src/messaging/campaigns-messaging.constants.js");
for (const kind of CAMPAIGNS_CONSUMER_KINDS) {
	const queue = CAMPAIGNS_QUEUE_NAMES[kind];
	process.stdout.write(`${queue}\n${queue}.dead-letter\n`);
	for (let index = 0; index < CAMPAIGNS_RETRY_DELAYS_MS.length; index += 1) {
		process.stdout.write(`${queue}.retry.${index + 1}\n`);
	}
}
'
	)"
	required_queues+=$'\n'"$campaigns_required_queues"
	widgets_required_queues="$(
		docker run --rm --network none \
			--entrypoint node \
			"$WIDGETS_IMAGE" \
			-e '
const {
	WIDGETS_CONSUMER_KINDS,
	WIDGETS_QUEUE_NAMES,
	WIDGETS_RETRY_DELAYS_MS,
} = require("./dist/src/messaging/widgets-messaging.constants.js");
for (const kind of WIDGETS_CONSUMER_KINDS) {
	const queue = WIDGETS_QUEUE_NAMES[kind];
	process.stdout.write(`${queue}\n${queue}.dead-letter\n`);
	for (let index = 0; index < WIDGETS_RETRY_DELAYS_MS.length; index += 1) {
		process.stdout.write(`${queue}.retry.${index + 1}\n`);
	}
}
'
	)"
	required_queues+=$'\n'"$widgets_required_queues"
	required_queues+=$'\nwinwidget.notification.telegram-destination-unavailable'
	required_queues+=$'\nwinwidget.notification.telegram-destination-unavailable.dead-letter'
	required_queues+=$'\nwinwidget.notification.telegram-destination-unavailable.retry-v2.1'
	required_queues+=$'\nwinwidget.notification.telegram-destination-unavailable.retry-v2.2'
	required_queues+=$'\nwinwidget.notification.telegram-destination-unavailable.retry-v2.3'

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		actual_queues="$(
			docker exec "$rabbitmq_container_id" \
				rabbitmqctl --silent list_queues -p "$rabbitmq_vhost" name \
				2>/dev/null || true
		)"
		all_ready=true
		while IFS= read -r required_queue; do
			[[ -n "$required_queue" ]] || continue
			if ! grep -Fqx -- "$required_queue" <<<"$actual_queues"; then
				all_ready=false
				break
			fi
		done <<<"$required_queues"
		if [[ "$all_ready" == "true" ]]; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "RabbitMQ topology owner did not create all worker queues" >&2
	compose_target logs --tail=100 outbox-publisher rabbitmq || true
	return 1
}

verify_notification_delivery_runtime_crud() {
	compose_target run --rm --no-deps \
		--entrypoint node \
		notification-delivery-worker \
		-e '
const { randomUUID } = require("node:crypto");
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});
const instanceId = `deployment-smoke-${randomUUID()}`;

prisma
	.$transaction(async transaction => {
		const grants = await transaction.$queryRawUnsafe(`
			SELECT
				tablename,
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$insert$INSERT$insert$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$update$UPDATE$update$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$delete$DELETE$delete$
				) AS allowed
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
				AND tablename <> $migrations$_prisma_migrations$migrations$
		`);
		if (
			!Array.isArray(grants) ||
			grants.length === 0 ||
			grants.some(grant => grant.allowed !== true)
		) {
			throw new Error("runtime CRUD grants are incomplete");
		}
		const migrationTablePrivileges = await transaction.$queryRawUnsafe(`
			SELECT (
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$insert$INSERT$insert$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$update$UPDATE$update$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$delete$DELETE$delete$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$truncate$TRUNCATE$truncate$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$references$REFERENCES$references$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$trigger$TRIGGER$trigger$
				)
			) AS allowed
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
				AND tablename = $migrations$_prisma_migrations$migrations$
		`);
		if (
			migrationTablePrivileges.length !== 1 ||
			migrationTablePrivileges[0]?.allowed !== false
		) {
			throw new Error(
				"runtime role must not access the Prisma migration history table",
			);
		}
		const privilegeRows = await transaction.$queryRawUnsafe(`
			SELECT
				roles.rolsuper AS role_super,
				roles.rolcreatedb AS role_create_database,
				roles.rolcreaterole AS role_create_role,
				pg_get_userbyid(databases.datdba) = current_user AS database_owner,
				pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
				has_database_privilege(
					current_user,
					current_database(),
					$privilege$CREATE$privilege$
				) AS database_create,
				has_schema_privilege(
					current_user,
					$schema$notification_delivery$schema$,
					$privilege$CREATE$privilege$
				) AS schema_create
			FROM pg_roles AS roles
			JOIN pg_database AS databases
				ON databases.datname = current_database()
			JOIN pg_namespace AS namespaces
				ON namespaces.nspname = $schema$notification_delivery$schema$
			WHERE roles.rolname = current_user
		`);
		const privilege = privilegeRows[0];
		if (
			privilegeRows.length !== 1 ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== false ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== false
		) {
			throw new Error("runtime role has unsafe PostgreSQL privileges");
		}
		const foreignTablePrivileges = await transaction.$queryRawUnsafe(`
			SELECT schemaname, tablename
			FROM pg_tables
			WHERE schemaname <> $schema$notification_delivery$schema$
				AND schemaname NOT IN (
					$catalog$pg_catalog$catalog$,
					$information$information_schema$information$
				)
				AND (
					has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$select$SELECT$select$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$insert$INSERT$insert$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$update$UPDATE$update$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$delete$DELETE$delete$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$truncate$TRUNCATE$truncate$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$references$REFERENCES$references$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$trigger$TRIGGER$trigger$
					)
				)
		`);
		if (
			!Array.isArray(foreignTablePrivileges) ||
			foreignTablePrivileges.length > 0
		) {
			throw new Error(
				"runtime role has table privileges outside notification_delivery",
			);
		}
		const foreignSchemaCreatePrivileges =
			await transaction.$queryRawUnsafe(`
				SELECT namespaces.nspname
				FROM pg_namespace AS namespaces
				WHERE namespaces.nspname <> $schema$notification_delivery$schema$
					AND namespaces.nspname <> $information$information_schema$information$
					AND left(namespaces.nspname, 3) <> $system$pg_$system$
					AND has_schema_privilege(
						current_user,
						namespaces.oid,
						$privilege$CREATE$privilege$
					)
			`);
		if (
			!Array.isArray(foreignSchemaCreatePrivileges) ||
			foreignSchemaCreatePrivileges.length > 0
		) {
			throw new Error(
				"runtime role has CREATE on a schema outside notification_delivery",
			);
		}
		await transaction.notificationDeliveryHeartbeat.create({
			data: {
				service: "deployment-runtime-crud-smoke",
				instanceId,
				metadata: { phase: "created" },
			},
		});
		const created =
			await transaction.notificationDeliveryHeartbeat.findUnique({
				where: {
					service_instanceId: {
						service: "deployment-runtime-crud-smoke",
						instanceId,
					},
				},
			});
		if (!created) throw new Error("runtime SELECT did not return the smoke row");

		await transaction.notificationDeliveryHeartbeat.update({
			where: {
				service_instanceId: {
					service: "deployment-runtime-crud-smoke",
					instanceId,
				},
			},
			data: { metadata: { phase: "updated" } },
		});
		await transaction.notificationDeliveryHeartbeat.delete({
			where: {
				service_instanceId: {
					service: "deployment-runtime-crud-smoke",
					instanceId,
				},
			},
		});
	})
	.then(() => {
		process.stdout.write(
			"Notification delivery runtime CRUD permissions verified\n",
		);
	})
	.catch(() => {
		process.stderr.write(
			"Notification delivery runtime role failed the CRUD permissions smoke\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
	'
}

verify_notification_delivery_migration_boundary() {
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps \
		--entrypoint node \
		notification-delivery-migrate \
		-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});

prisma
	.$queryRawUnsafe(`
		SELECT
			roles.rolsuper AS role_super,
			roles.rolcreatedb AS role_create_database,
			roles.rolcreaterole AS role_create_role,
			pg_get_userbyid(databases.datdba) = current_user AS database_owner,
			pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
			has_database_privilege(
				current_user,
				current_database(),
				$privilege$CREATE$privilege$
			) AS database_create,
			has_schema_privilege(
				current_user,
				$schema$notification_delivery$schema$,
				$privilege$CREATE$privilege$
			) AS schema_create
		FROM pg_roles AS roles
		JOIN pg_database AS databases
			ON databases.datname = current_database()
		JOIN pg_namespace AS namespaces
			ON namespaces.nspname = $schema$notification_delivery$schema$
		WHERE roles.rolname = current_user
	`)
	.then(rows => {
		const privilege = rows[0];
		if (
			rows.length !== 1 ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== true ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== true
		) {
			throw new Error("migration role has unsafe PostgreSQL privileges");
		}
		process.stdout.write(
			"Notification delivery migration role boundary verified\n",
		);
	})
	.catch(() => {
		process.stderr.write(
			"Notification delivery migration role failed its privilege boundary smoke\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

finalize_notification_delivery_backup_grants() {
	local backup_role

	backup_role="$(get_database_username NOTIFICATION_DELIVERY_BACKUP_URL)"
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps \
		-e "NOTIFICATION_DELIVERY_BACKUP_ROLE=$backup_role" \
		--entrypoint node \
		notification-delivery-migrate \
		-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const backupRole = process.env.NOTIFICATION_DELIVERY_BACKUP_ROLE?.trim();
if (!backupRole || !/^[A-Za-z0-9._-]+$/.test(backupRole)) {
	throw new Error("Notification delivery backup role name is invalid");
}
const quotedRole = `"${backupRole.replaceAll("\"", "\"\"")}"`;
const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});

prisma
	.$transaction([
		prisma.$executeRawUnsafe(
			`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA notification_delivery FROM ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA notification_delivery FROM ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`GRANT USAGE ON SCHEMA notification_delivery TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`GRANT SELECT ON ALL TABLES IN SCHEMA notification_delivery TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`GRANT SELECT ON ALL SEQUENCES IN SCHEMA notification_delivery TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA notification_delivery GRANT SELECT ON TABLES TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA notification_delivery GRANT SELECT ON SEQUENCES TO ${quotedRole}`,
		),
	])
	.then(() => {
		process.stdout.write(
			"Notification delivery backup grants finalized\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Notification delivery backup grant finalization failed"}\n`,
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

verify_notification_delivery_backup_boundary() {
	compose_target run --rm --no-deps \
		--entrypoint node \
		maintenance-worker \
		-e '
const { PrismaClient } = require("@prisma/client");

const backupUrl = new URL(process.env.NOTIFICATION_DELIVERY_BACKUP_URL);
const expectedDatabase = decodeURIComponent(backupUrl.pathname.slice(1));
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expectedDatabase)) {
	throw new Error("notification delivery backup database name is invalid");
}

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_BACKUP_URL,
		},
	},
});

prisma
	.$transaction(async transaction => {
		const tables = await transaction.$queryRawUnsafe(`
			SELECT
				tablename,
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				) AS can_select,
				(
					has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$insert$INSERT$insert$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$update$UPDATE$update$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$delete$DELETE$delete$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$truncate$TRUNCATE$truncate$
					)
				) AS can_write
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
		`);
		if (
			!Array.isArray(tables) ||
			tables.length === 0 ||
			tables.some(
				table => table.can_select !== true || table.can_write !== false,
			)
		) {
			throw new Error(
				"notification delivery backup role must have read-only access to every service table",
			);
		}

		const sequences = await transaction.$queryRawUnsafe(`
			SELECT
				sequencename,
				has_sequence_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, sequencename),
					$select$SELECT$select$
				) AS can_select,
				(
					has_sequence_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, sequencename),
						$usage$USAGE$usage$
					)
					OR has_sequence_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, sequencename),
						$update$UPDATE$update$
					)
				) AS can_advance
			FROM pg_sequences
			WHERE schemaname = $schema$notification_delivery$schema$
		`);
		if (
			!Array.isArray(sequences) ||
			sequences.some(
				sequence =>
					sequence.can_select !== true ||
					sequence.can_advance !== false,
			)
		) {
			throw new Error(
				"notification delivery backup role has unsafe sequence privileges",
			);
		}

		const privilegeRows = await transaction.$queryRawUnsafe(`
			SELECT
				current_database() AS database_name,
				roles.rolsuper AS role_super,
				roles.rolcreatedb AS role_create_database,
				roles.rolcreaterole AS role_create_role,
				pg_get_userbyid(databases.datdba) = current_user AS database_owner,
				pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
				has_database_privilege(
					current_user,
					current_database(),
					$privilege$CREATE$privilege$
				) AS database_create,
				has_schema_privilege(
					current_user,
					$schema$notification_delivery$schema$,
					$privilege$CREATE$privilege$
				) AS schema_create
			FROM pg_roles AS roles
			JOIN pg_database AS databases
				ON databases.datname = current_database()
			JOIN pg_namespace AS namespaces
				ON namespaces.nspname = $schema$notification_delivery$schema$
			WHERE roles.rolname = current_user
		`);
		const privilege = privilegeRows[0];
		if (
			privilegeRows.length !== 1 ||
			privilege?.database_name !== expectedDatabase ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== false ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== false
		) {
			throw new Error(
				"notification delivery backup role has unsafe PostgreSQL privileges",
			);
		}
	})
	.then(() => {
		process.stdout.write(
			"Notification delivery backup role boundary verified\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Notification delivery backup role verification failed"}\n`,
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

verify_notification_delivery_control_smoke() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const { randomUUID } = require("node:crypto");
const {
	NotificationDeliveryClientService,
	NotificationDeliveryInternalApiError,
} = require("./dist/src/messaging/notification-delivery-client.service.js");

const expectValidationFailure = async (operation, label) => {
	try {
		await operation();
	} catch (error) {
		if (
			error instanceof NotificationDeliveryInternalApiError &&
			error.statusCode === 400
		) {
			return;
		}
		throw error;
	}
	throw new Error(`${label} did not preserve its validation contract`);
};
const run = async () => {
	const configService = {
		get: key => process.env[key],
	};
	const client = new NotificationDeliveryClientService(configService);
	await client.getOverview();
	await client.getFailures(1, 1, {});
	const validationId = randomUUID();
	await expectValidationFailure(
		() => client.retryFailure(validationId, ""),
		"retry endpoint",
	);
	await expectValidationFailure(
		() =>
			client.closeFailure(
				validationId,
				"deployment-control-smoke",
				"x",
			),
		"close endpoint",
	);
};

run()
	.then(() => {
		process.stdout.write(
			"Notification delivery internal control endpoint verified\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Notification delivery internal control endpoint smoke failed"}\n`,
		);
		process.exitCode = 1;
	});
'
}

verify_exact_worker_consumer_ownership() {
	local close_legacy_orphans="${1:-false}"
	local notification_owner="${2:-notification}"
	local billing_owner_active='false'
	local notification_queue_names_json
	local campaigns_queue_names_json
	if [[ "$billing_database_phase" == 'active' ||
		"$billing_database_phase" == 'complete' ]]; then
		billing_owner_active='true'
	fi
	notification_queue_names_json="$(
		docker run --rm --network none \
			--entrypoint node "$NOTIFICATION_DELIVERY_IMAGE" \
			-e '
const {
	MESSAGING_QUEUE_NAMES,
	NOTIFICATION_DELIVERY_KINDS,
} = require("./dist/src/messaging/messaging.constants.js");
process.stdout.write(JSON.stringify(Object.fromEntries(
	NOTIFICATION_DELIVERY_KINDS.map(kind => [kind, MESSAGING_QUEUE_NAMES[kind]]),
)));
'
	)"
	campaigns_queue_names_json="$(
		docker run --rm --network none \
			--entrypoint node "$CAMPAIGNS_IMAGE" \
			-e '
const {
	CAMPAIGNS_QUEUE_NAMES,
} = require("./dist/src/messaging/campaigns-messaging.constants.js");
process.stdout.write(JSON.stringify(Object.values(CAMPAIGNS_QUEUE_NAMES)));
'
	)"

	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		-e "CLOSE_LEGACY_NOTIFICATION_CONSUMERS=$close_legacy_orphans" \
		-e "EXPECTED_NOTIFICATION_QUEUE_OWNER=$notification_owner" \
		-e "EXPECTED_INTEGRATION_KINDS=$expected_integration_worker_kinds" \
		-e "BILLING_OWNER_ACTIVE=$billing_owner_active" \
		-e "NOTIFICATION_QUEUE_NAMES_JSON=$notification_queue_names_json" \
		-e "CAMPAIGNS_QUEUE_NAMES_JSON=$campaigns_queue_names_json" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const {
	BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME,
	MESSAGING_QUEUE_NAMES,
} = require("./dist/src/messaging/messaging.constants.js");

class OwnershipError extends Error {}

const decodeUser = (value, label) => {
	try {
		const url = new URL(value || "");
		const username = decodeURIComponent(url.username);
		if (!username) throw new Error();
		return username;
	} catch {
		throw new OwnershipError(`${label} has no valid user`);
	}
};

const run = async () => {
	const baseUrl = (
		process.env.RABBITMQ_MANAGEMENT_URL ||
		"http://127.0.0.1:15672"
	).replace(/\/$/, "");
	const vhost = process.env.RABBITMQ_VHOST || "winwidget";
	const adminUser = process.env.RABBITMQ_ADMIN_USER;
	const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
	if (!adminUser || !adminPassword) {
		throw new OwnershipError("RabbitMQ admin credentials are missing");
	}
	const authorization = `Basic ${Buffer.from(
		`${adminUser}:${adminPassword}`,
	).toString("base64")}`;
	const request = async (path, options = {}) => {
		const response = await fetch(`${baseUrl}${path}`, {
			...options,
			headers: {
				Authorization: authorization,
				...(options.headers || {}),
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new OwnershipError(
				`RabbitMQ Management returned HTTP ${response.status}`,
			);
		}
		if (response.status === 204) return null;
		return response.json();
	};

	const connections = await request("/api/connections");
	if (!Array.isArray(connections)) {
		throw new OwnershipError("RabbitMQ connections response is invalid");
	}
	const bySocketName = new Map(
		connections.map(connection => [connection.name, connection]),
	);
	const integrationUser = decodeUser(
		process.env.RABBITMQ_INTEGRATION_WORKER_URL,
		"RABBITMQ_INTEGRATION_WORKER_URL",
	);
	const billingOwnerActive = process.env.BILLING_OWNER_ACTIVE === "true";
	const billingUser = billingOwnerActive
		? decodeUser(
				process.env.RABBITMQ_BILLING_WORKER_URL,
				"RABBITMQ_BILLING_WORKER_URL",
			)
		: null;
	const notificationUser = decodeUser(
		process.env.RABBITMQ_NOTIFICATION_DELIVERY_URL,
		"RABBITMQ_NOTIFICATION_DELIVERY_URL",
	);
	const campaignsUser = decodeUser(
		process.env.RABBITMQ_CAMPAIGNS_URL,
		"RABBITMQ_CAMPAIGNS_URL",
	);
	const identityUser = decodeUser(
		process.env.RABBITMQ_IDENTITY_WORKER_URL,
		"RABBITMQ_IDENTITY_WORKER_URL",
	);
	let campaignsQueues;
	try {
		campaignsQueues = JSON.parse(process.env.CAMPAIGNS_QUEUE_NAMES_JSON || "");
	} catch {
		throw new OwnershipError("Campaigns queue contract is invalid");
	}
	if (
		!Array.isArray(campaignsQueues) ||
		campaignsQueues.length !== 2 ||
		campaignsQueues.some(queue => typeof queue !== "string" || !queue)
	) {
		throw new OwnershipError("Campaigns queue contract is incomplete");
	}
	const legacyTelegramOwner =
		process.env.EXPECTED_NOTIFICATION_QUEUE_OWNER === "legacy";
	const expectedIntegrationKinds = (
		process.env.EXPECTED_INTEGRATION_KINDS || ""
	)
		.split(",")
		.map(value => value.trim())
		.filter(Boolean);
	if (!expectedIntegrationKinds.length) {
		throw new OwnershipError("Expected integration kind contract is missing");
	}
	let notificationQueueNames;
	try {
		notificationQueueNames = JSON.parse(
			process.env.NOTIFICATION_QUEUE_NAMES_JSON || "",
		);
	} catch {
		throw new OwnershipError("Notification Delivery queue contract is invalid");
	}
	if (
		!notificationQueueNames ||
		typeof notificationQueueNames !== "object" ||
		Array.isArray(notificationQueueNames)
	) {
		throw new OwnershipError("Notification Delivery queue contract is incomplete");
	}
	const groups = [
		{
			queues: [
				"email",
				"telegram",
				"payment-email",
				"limit-email",
				...(legacyTelegramOwner
					? []
					: [
							"campaign-email",
							"campaign-telegram",
							"daily-summary-delivery-telegram",
							"subscription-expiry-email",
							"subscription-expiry-telegram",
						]),
			].map(kind => notificationQueueNames[kind]),
			user: notificationUser,
			connectionName: "winwidget-notification-delivery-worker",
			notification: true,
		},
		{
			queues: legacyTelegramOwner
				? [
						"winwidget.payment-notification.telegram",
						"winwidget.limit-notification.telegram",
					]
				: [
						notificationQueueNames["payment-telegram"],
						notificationQueueNames["limit-telegram"],
					],
			user: legacyTelegramOwner ? integrationUser : notificationUser,
			connectionName: legacyTelegramOwner
				? "winwidget-integration-worker"
				: "winwidget-notification-delivery-worker",
			notification: true,
		},
		{
			kinds: expectedIntegrationKinds.filter(
				kind =>
					!(
						billingOwnerActive &&
						(kind === "auto-renewal" ||
							kind === "notification-delivery-outcome")
					),
			),
			user: integrationUser,
			connectionName: "winwidget-integration-worker",
			notification: false,
		},
		...(billingOwnerActive
			? [
					{
						queues: [
							MESSAGING_QUEUE_NAMES["auto-renewal"],
							BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME,
						],
						user: billingUser,
						connectionName: "winwidget-billing-worker",
						notification: false,
						includeDeadLetter: false,
					},
				]
			: []),
		{
			queues: campaignsQueues,
			user: campaignsUser,
			connectionName: "winwidget-campaigns-service",
			notification: false,
			includeDeadLetter: false,
		},
		{
			queues: ["winwidget.notification.telegram-destination-unavailable"],
			user: identityUser,
			connectionName: "winwidget-identity-worker",
			notification: false,
			includeDeadLetter: false,
		},
	];

	let closedLegacyOrphan = false;
	for (const group of groups) {
		const baseQueues =
			group.queues ??
			group.kinds.map(kind => MESSAGING_QUEUE_NAMES[kind]);
		for (const baseQueue of baseQueues) {
			if (!baseQueue) {
				throw new OwnershipError(
					"RabbitMQ ownership group contains an unknown queue",
				);
			}
			const consumedQueues =
				group.includeDeadLetter === false
					? [baseQueue]
					: [baseQueue, `${baseQueue}.dead-letter`];
			for (const queue of consumedQueues) {
				const state = await request(
					`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(
						queue,
					)}`,
				);
				const consumers = Array.isArray(state?.consumer_details)
					? state.consumer_details
					: [];

				for (const consumer of consumers) {
					const socketName =
						consumer?.channel_details?.connection_name;
					const connection = bySocketName.get(socketName);
					const clientName =
						connection?.client_properties?.connection_name;
					if (
						group.notification &&
						process.env.CLOSE_LEGACY_NOTIFICATION_CONSUMERS ===
							"true" &&
						connection?.user === integrationUser &&
						clientName === "winwidget-integration-worker"
					) {
						await request(
							`/api/connections/${encodeURIComponent(
								connection.name,
							)}`,
							{
								method: "DELETE",
								headers: {
									"X-Reason":
										"WinWidget notification cutover ownership repair",
								},
							},
						);
						closedLegacyOrphan = true;
					}
				}

				if (closedLegacyOrphan) continue;
				if (consumers.length !== 1) {
					throw new OwnershipError(
						`RabbitMQ queue ${queue} must have exactly one consumer`,
					);
				}
				const socketName =
					consumers[0]?.channel_details?.connection_name;
				const connection = bySocketName.get(socketName);
				const clientName =
					connection?.client_properties?.connection_name;
				if (
					connection?.user !== group.user ||
					clientName !== group.connectionName
				) {
					throw new OwnershipError(
						`RabbitMQ queue ${queue} has an unexpected owner`,
					);
				}
			}
		}
	}

	for (const baseQueue of campaignsQueues) {
		for (const queue of [
			`${baseQueue}.dead-letter`,
			`${baseQueue}.retry.1`,
			`${baseQueue}.retry.2`,
			`${baseQueue}.retry.3`,
		]) {
			const state = await request(
				`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(
					queue,
				)}`,
			);
			const consumers = Array.isArray(state?.consumer_details)
				? state.consumer_details
				: [];
			if (consumers.length !== 0) {
				throw new OwnershipError(
					`RabbitMQ Campaigns parking queue ${queue} must have no consumers`,
				);
			}
		}
	}

	for (const suffix of [
		".dead-letter",
		".retry-v2.1",
		".retry-v2.2",
		".retry-v2.3",
	]) {
		const queue = `winwidget.notification.telegram-destination-unavailable${suffix}`;
		const state = await request(
			`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`,
		);
		const consumers = Array.isArray(state?.consumer_details)
			? state.consumer_details
			: [];
		if (consumers.length !== 0) {
			throw new OwnershipError(
				`RabbitMQ Identity parking queue ${queue} must have no consumers`,
			);
		}
	}

	if (billingOwnerActive) {
		for (const baseQueue of [
			MESSAGING_QUEUE_NAMES["auto-renewal"],
			BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME,
		]) {
			for (const suffix of [
				".dead-letter",
				".retry.1",
				".retry.2",
				".retry.3",
			]) {
				const queue = `${baseQueue}${suffix}`;
				const state = await request(
					`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`,
				);
				const consumers = Array.isArray(state?.consumer_details)
					? state.consumer_details
					: [];
				if (consumers.length !== 0) {
					throw new OwnershipError(
						`RabbitMQ Billing parking queue ${queue} must have no consumers`,
					);
				}
			}
		}
	}

	if (closedLegacyOrphan) {
		throw new OwnershipError(
			"Closed an orphan legacy notification consumer; ownership must be rechecked",
		);
	}
};

run()
	.then(() => {
		process.stdout.write("RabbitMQ consumer ownership verified\n");
	})
	.catch(error => {
		const message =
			error instanceof OwnershipError
				? error.message
				: "RabbitMQ consumer ownership could not be verified";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
'
}

first_cutover_producer_ids=()
first_cutover_legacy_worker_id=""
first_cutover_legacy_notification_worker_id=""
first_cutover_candidate_started=false
first_cutover_marker_tmp=""
first_cutover_recovery_active=false
forward_cutover_recovery_active=false
notification_cutover_last_queue_state=""
notification_cutover_last_database_state=""
notification_cutover_last_service_state=""

print_notification_cutover_runbook() {
	cat >&2 <<'RUNBOOK'
Notification Delivery provider-ownership cutover did not pass.
Do not start the expanded Notification Delivery worker while legacy provider
calls can still be in flight.

Manual recovery/runbook:
1. Keep the current v1 Notification Delivery worker and integration worker running.
2. Through the existing Messaging admin flow, resolve or retry every unresolved
   payment-telegram and limit-telegram failure.
3. Wait until PROCESSING/RETRY_SCHEDULED receipts for payment/limit Telegram
   and campaigns disappear, subscription reminders have no
   PROCESSING rows, and every matching main, retry-v2.* and dead-letter queue
   reports zero ready and zero unacknowledged messages.
4. Re-run the full `all` deployment. The script will stop producers, recheck the
   quiescent boundary, stop both old workers, then start the disjoint workers.
5. Do not use the notification-delivery service-only target until
   `.notification-delivery-telegram-cutover-v1` exists.
RUNBOOK
}

notification_cutover_expected_queues() {
	local base_queue
	local retry_index

	for base_queue in \
		winwidget.payment-notification.telegram \
		winwidget.limit-notification.telegram; do
		printf '%s\n%s.dead-letter\n' "$base_queue" "$base_queue"
		for retry_index in 1 2 3; do
			printf '%s.retry-v2.%s\n' "$base_queue" "$retry_index"
		done
	done
	if [[ "$first_cutover_candidate_started" == "true" ]]; then
		base_queue="winwidget.payment-notification.telegram.v2"
		printf '%s\n%s.dead-letter\n' "$base_queue" "$base_queue"
		for retry_index in 1 2 3; do
			printf '%s.retry-v2.%s\n' "$base_queue" "$retry_index"
		done
	fi
}

notification_cutover_queue_state() {
	local rabbitmq_container_id

	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq
	)"
	if [[ -z "$rabbitmq_container_id" ||
		"$rabbitmq_container_id" == *$'\n'* ]]; then
		echo "Exactly one running RabbitMQ container is required for notification cutover." >&2
		return 1
	fi

	docker exec "$rabbitmq_container_id" \
		rabbitmqctl --silent list_queues \
			-p "$rabbitmq_vhost" \
			name messages_ready messages_unacknowledged consumers |
		awk '
			$1 ~ /^winwidget\.payment-notification\.telegram(\.v2)?(\.|$)/ ||
			$1 ~ /^winwidget\.limit-notification\.telegram(\.|$)/
		'
}

notification_cutover_database_state() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.DATABASE_URL_PRODUCTION,
		},
	},
});
const ownershipKinds = ["payment-telegram", "limit-telegram"];

Promise.all([
	prisma.integrationDeliveryFailure.count({
		where: {
			integration: { in: ownershipKinds },
			resolvedAt: null,
		},
	}),
	prisma.integrationDeliveryReceipt.count({
		where: {
			integration: { in: ownershipKinds },
			status: { in: ["PROCESSING", "RETRY_SCHEDULED"] },
		},
	}),
	prisma.outboxEvent.count({
		where: {
				routingKey: {
					in: [
						"payment.succeeded.v1",
						"lead.limit.reached.telegram.v2",
					],
			},
			status: { in: ["PENDING", "PUBLISHING", "FAILED"] },
		},
	}),
])
	.then(
		([
			unresolvedFailures,
			activeReceipts,
			pendingOutbox
		]) => {
			process.stdout.write(
				`${unresolvedFailures}\t${activeReceipts}\t${pendingOutbox}\n`,
			);
		},
	)
	.catch(() => {
		process.stderr.write(
			"Notification cutover could not query public delivery state\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

notification_delivery_service_state() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"$NOTIFICATION_DELIVERY_IMAGE" \
		-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");
const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});

const kinds = ["payment-telegram", "limit-telegram"];
Promise.all([
	prisma.notificationDeliveryReceipt.count({
		where: { consumer: { in: kinds } },
	}),
	prisma.notificationDeliveryFailure.count({
		where: { consumer: { in: kinds } },
	}),
	prisma.notificationDeliveryOutboxEvent.count({
		where: {
			OR: [
				{ routingKey: { in: ["manual.payment-telegram", "manual.limit-telegram"] } },
				{ routingKey: { in: ["payment-telegram.dead-letter", "limit-telegram.dead-letter"] } },
				{ routingKey: "notification.telegram.destination-unavailable.v1" },
			],
		},
	}),
])
	.then(([receipts, failures, outbox]) => {
		process.stdout.write(`${receipts}\t${failures}\t${outbox}\n`);
	})
	.catch(() => {
		process.stderr.write(
			"Notification cutover could not query service-owned state\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

notification_delivery_service_state_is_empty() {
	local receipts
	local failures
	local outbox

	notification_cutover_last_service_state="$(
		notification_delivery_service_state
	)" || return 1
	IFS=$'\t' read -r receipts failures outbox \
		<<<"$notification_cutover_last_service_state"
	if [[ ! "$receipts" =~ ^[0-9]+$ ||
		! "$failures" =~ ^[0-9]+$ ||
		! "$outbox" =~ ^[0-9]+$ ]]; then
		return 1
	fi
	[[ "$receipts" == "0" && "$failures" == "0" && "$outbox" == "0" ]]
}

notification_cutover_consumers_ready() {
	local state
	local queue
	local queue_line
	local _name
	local ready
	local unacknowledged
	local consumers

	state="$(notification_cutover_queue_state)"
	for queue in \
		winwidget.payment-notification.telegram \
		winwidget.payment-notification.telegram.dead-letter \
		winwidget.limit-notification.telegram \
		winwidget.limit-notification.telegram.dead-letter; do
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; exit }' <<<"$state"
		)"
		if [[ -z "$queue_line" ]]; then
			echo "Missing RabbitMQ queue required for Telegram cutover: $queue" >&2
			return 1
		fi
		read -r _name ready unacknowledged consumers <<<"$queue_line"
		if [[ ! "$consumers" =~ ^[1-9][0-9]*$ ]]; then
			echo "Legacy integration-worker is not consuming queue: $queue" >&2
			return 1
		fi
	done
}

notification_cutover_is_clear() {
	local expected_queue
	local queue_line
	local _name
	local ready
	local unacknowledged
	local _consumers
	local unresolved_failures
	local active_receipts
	local pending_outbox

	notification_cutover_last_queue_state="$(
		notification_cutover_queue_state
	)"
	while IFS= read -r expected_queue; do
		[[ -n "$expected_queue" ]] || continue
		queue_line="$(
			awk -v queue="$expected_queue" \
				'$1 == queue { print; exit }' \
				<<<"$notification_cutover_last_queue_state"
		)"
		if [[ -z "$queue_line" ]]; then
			return 1
		fi
		read -r _name ready unacknowledged _consumers <<<"$queue_line"
		if [[ ! "$ready" =~ ^[0-9]+$ ||
			! "$unacknowledged" =~ ^[0-9]+$ ||
			"$ready" != "0" ||
			"$unacknowledged" != "0" ]]; then
			return 1
		fi
	done < <(notification_cutover_expected_queues)

	notification_cutover_last_database_state="$(
		notification_cutover_database_state
	)"
	IFS=$'\t' read -r unresolved_failures active_receipts pending_outbox \
		<<<"$notification_cutover_last_database_state"
	if [[ ! "$unresolved_failures" =~ ^[0-9]+$ ||
		! "$active_receipts" =~ ^[0-9]+$ ||
		! "$pending_outbox" =~ ^[0-9]+$ ]]; then
		return 1
	fi
	[[ "$unresolved_failures" == "0" &&
		"$active_receipts" == "0" &&
		"$pending_outbox" == "0" ]]
}

delete_legacy_payment_telegram_queues() {
	local rabbitmq_container_id
	local queue
	local queue_line
	local _name
	local ready
	local unacknowledged
	local consumers
	local state

	if ! validate_notification_cutover_marker; then
		echo "Refusing to delete legacy payment Telegram queues before the durable Telegram cutover marker." >&2
		return 1
	fi
	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq
	)"
	if [[ -z "$rabbitmq_container_id" ||
		"$rabbitmq_container_id" == *$'\n'* ]]; then
		echo "Exactly one running RabbitMQ container is required to retire legacy queues." >&2
		return 1
	fi
	state="$(
		docker exec "$rabbitmq_container_id" \
			rabbitmqctl --silent list_queues \
				-p "$rabbitmq_vhost" \
				name messages_ready messages_unacknowledged consumers
	)"
	for queue in \
		winwidget.payment-notification.telegram \
		winwidget.payment-notification.telegram.dead-letter \
		winwidget.payment-notification.telegram.retry-v2.1 \
		winwidget.payment-notification.telegram.retry-v2.2 \
		winwidget.payment-notification.telegram.retry-v2.3; do
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; exit }' <<<"$state"
		)"
		if [[ -z "$queue_line" ]]; then
			continue
		fi
		read -r _name ready unacknowledged consumers <<<"$queue_line"
		if [[ "$ready" != "0" ||
			"$unacknowledged" != "0" ||
			"$consumers" != "0" ]]; then
			echo "Legacy queue is not strictly empty/unowned and cannot be deleted: $queue" >&2
			return 1
		fi
	done
	for queue in \
		winwidget.payment-notification.telegram \
		winwidget.payment-notification.telegram.dead-letter \
		winwidget.payment-notification.telegram.retry-v2.1 \
		winwidget.payment-notification.telegram.retry-v2.2 \
		winwidget.payment-notification.telegram.retry-v2.3; do
		if awk -v queue="$queue" '$1 == queue { found = 1 } END { exit(found ? 0 : 1) }' \
			<<<"$state"; then
			docker exec "$rabbitmq_container_id" \
				rabbitmqctl delete_queue -p "$rabbitmq_vhost" \
					"$queue" --if-empty --if-unused \
				>/dev/null
		fi
	done
	echo "Strictly empty legacy payment Telegram queues were retired."
}

restore_first_cutover_producers_on_exit() {
	local status=$?
	local recovery_failed=false
	local container_id
	local running
	local attempt

	trap - EXIT INT TERM
	if [[ "$first_cutover_recovery_active" != "true" ]]; then
		exit "$status"
	fi

	set +e
	echo "First notification delivery cutover failed before its durable marker; restoring the exact legacy runtime." >&2
	if [[ -n "$first_cutover_marker_tmp" ]]; then
		rm -f "$first_cutover_marker_tmp"
	fi

	if [[ "$first_cutover_candidate_started" == "true" ]]; then
		if ! notification_delivery_service_state_is_empty ||
			! notification_cutover_is_clear ||
			! notification_delivery_service_state_is_empty; then
			echo "CRITICAL: pre-marker state is non-empty or unreadable; refusing automatic legacy rollback." >&2
			echo "Service state (receipts failures outbox): ${notification_cutover_last_service_state:-unavailable}" >&2
			echo "Moved queue state:" >&2
			echo "${notification_cutover_last_queue_state:-unavailable}" >&2
			echo "Candidate workers stay running while producers and public Gateway remain stopped. Resolve the forward state manually." >&2
			exit "$status"
		fi
		if ! stop_notification_cutover_services 30 true \
			"${notification_cutover_pre_marker_services[@]}" \
			>/dev/null 2>&1; then
			recovery_failed=true
		fi
		if ! remove_notification_cutover_services \
			"${notification_cutover_candidate_services[@]}" \
			>/dev/null 2>&1; then
			recovery_failed=true
		fi
	fi

	if ! provision_rabbitmq_user \
		"$integration_user" \
		"$integration_password_base64" \
		'^$' \
		'^(winwidget\.retry|winwidget\.dead-letter)$' \
		"$legacy_integration_read_pattern" \
		''; then
		echo "CRITICAL: broad legacy RabbitMQ permissions could not be restored." >&2
		recovery_failed=true
	fi

	if [[ -n "$first_cutover_legacy_worker_id" ]]; then
		if ! docker image inspect "$(
			docker inspect --format '{{ .Image }}' \
				"$first_cutover_legacy_worker_id" 2>/dev/null
		)" >/dev/null 2>&1 ||
			! routine_require_platform_admin_audit_topology ||
			! docker start "$first_cutover_legacy_worker_id" >/dev/null; then
			echo "CRITICAL: the unchanged legacy integration worker could not be restarted." >&2
			recovery_failed=true
		fi
	fi
	if [[ -n "$first_cutover_legacy_notification_worker_id" ]]; then
		if ! docker image inspect "$(
			docker inspect --format '{{ .Image }}' \
				"$first_cutover_legacy_notification_worker_id" 2>/dev/null
		)" >/dev/null 2>&1 ||
			! docker start \
				"$first_cutover_legacy_notification_worker_id" >/dev/null; then
			echo "CRITICAL: the unchanged v1 Notification Delivery worker could not be restarted." >&2
			recovery_failed=true
		fi
	fi

	if [[ ${#first_cutover_producer_ids[@]} -gt 0 ]] &&
		! docker start "${first_cutover_producer_ids[@]}" >/dev/null; then
		echo "CRITICAL: one or more unchanged producer containers could not be restarted." >&2
		recovery_failed=true
	fi

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		running=true
		for container_id in \
			"$first_cutover_legacy_worker_id" \
			"$first_cutover_legacy_notification_worker_id" \
			"${first_cutover_producer_ids[@]}"; do
			[[ -n "$container_id" ]] || continue
			if [[ "$(docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null)" != "true" ]]; then
				running=false
				break
			fi
		done
		if [[ "$running" == "true" ]] &&
			curl -fsS --connect-timeout 3 --max-time 5 \
				"$HEALTHCHECK_URL" >/dev/null 2>&1 &&
			curl -fsS --connect-timeout 3 --max-time 5 \
				"$GATEWAY_READINESS_URL" >/dev/null 2>&1 &&
			notification_cutover_consumers_ready >/dev/null 2>&1 &&
			verify_exact_worker_consumer_ownership \
				false legacy >/dev/null 2>&1; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "CRITICAL: restored legacy containers did not pass readiness verification." >&2
			recovery_failed=true
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	if [[ "$recovery_failed" == "true" ]]; then
		echo "CRITICAL: automatic first-cutover recovery was incomplete; keep the marker absent and follow the manual runbook." >&2
	else
		echo "The unchanged legacy worker and producers were restored and verified." >&2
	fi
	exit "$status"
}

wait_for_cutover_revision() {
	local url="$1"
	local expected_revision="$2"
	local label="$3"
	local attempt
	local response

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		response="$(
			curl -fsS --connect-timeout 3 --max-time 5 \
				-H 'Cache-Control: no-cache' "$url" 2>/dev/null || true
		)"
		if [[ "$response" == *"\"revision\":\"$expected_revision\""* ]]; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "$label did not report revision $expected_revision." >&2
	return 1
}

wait_for_cutover_readiness() {
	local url="$1"
	local label="$2"
	local attempt

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if curl -fsS --connect-timeout 3 --max-time 5 \
			"$url" >/dev/null 2>&1; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "$label did not become ready." >&2
	return 1
}

show_reporting_startup_diagnostics() {
	echo 'Reporting startup diagnostics:' >&2
	compose_target ps reporting-service rabbitmq >&2 || true
	echo 'Reporting readiness response:' >&2
	curl -sS --connect-timeout 2 --max-time 5 -i \
		"$REPORTING_READINESS_URL" >&2 || true
	echo 'Reporting logs:' >&2
	compose_target logs --tail=200 reporting-service >&2 || true
}

start_canonical_reporting_runtime() {
	if ! compose_target up -d --no-deps --force-recreate reporting-service; then
		show_reporting_startup_diagnostics
		return 1
	fi
}

finish_canonical_reporting_runtime() {
	local label="${1:-Reporting}"

	if ! wait_for_cutover_revision \
		"$REPORTING_READINESS_URL" "$REPORTING_REVISION" "$label"; then
		show_reporting_startup_diagnostics
		return 1
	fi
	reporting_require_rabbitmq_topology
	provision_reporting_rabbitmq_topic_permissions "$reporting_user" steady
	reporting_runtime_container_before="$(
		compose_target ps --status running -q reporting-service
	)"
	reporting_runtime_image_before="$(
		docker inspect --format '{{.Image}}' "$reporting_runtime_container_before"
	)"
}

wait_for_database_restore_worker() {
	local attempt
	local container_id
	local health
	local image_revision

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(
			compose_target ps -q database-restore-worker 2>/dev/null || true
		)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			health="$(
				docker inspect --format \
					'{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
					"$container_id" 2>/dev/null || true
			)"
			image_revision="$(
				docker inspect --format \
					'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
					"$container_id" 2>/dev/null || true
			)"
			if [[ "$health" == 'healthy' &&
				"$image_revision" == "$DATABASE_RESTORE_REVISION" ]]; then
				return 0
			fi
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo 'Database restore worker did not publish revision-bound readiness.' >&2
	return 1
}

verify_active_reporting_runtime() {
	local expected_container_id="${1:-}" expected_image_id="${2:-}"
	local container_id health image_id image_revision app_revision restart_count
	local process_role scheduler_enabled expected_scheduler listen_host response
	local phase phase_index migrated_index scheduler_index
	container_id="$(compose_target ps -a -q reporting-service 2>/dev/null || true)"
	if [[ -z "$container_id" ]]; then
		[[ -z "$expected_container_id" || "$expected_container_id" == 'absent' ]] || {
			echo 'Reporting runtime disappeared during the coordinated deployment.' >&2
			return 1
		}
		if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
			echo 'Reporting cutover is active but reporting-service is absent.' >&2
			return 1
		fi
		return 0
	fi
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Reporting runtime identity is ambiguous.' >&2
		return 1
	}
	[[ "$expected_container_id" != 'absent' ]] || {
		echo 'Reporting runtime appeared during a full deployment which must not manage it.' >&2
		return 1
	}
	[[ -z "$expected_container_id" || "$container_id" == "$expected_container_id" ]] || {
		echo 'Reporting container identity changed during a full deployment.' >&2
		return 1
	}
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^APP_REVISION=//p')"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	process_role="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_PROCESS_ROLE=//p')"
	scheduler_enabled="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_SCHEDULER_ENABLED=//p')"
	listen_host="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_LISTEN_HOST=//p')"
	expected_scheduler="$(get_env_value REPORTING_SCHEDULER_ENABLED)"
	response="$(curl -fsS --connect-timeout 2 --max-time 5 "$REPORTING_READINESS_URL" 2>/dev/null || true)"
	[[ -z "$expected_image_id" || "$image_id" == "$expected_image_id" ]] || {
		echo 'Reporting image identity changed during a full deployment.' >&2
		return 1
	}
	[[ "$image_revision" =~ ^[0-9a-f]{40}$ ]] &&
		git -C "$server_root" cat-file -e "$image_revision^{commit}" 2>/dev/null &&
		git -C "$server_root" merge-base --is-ancestor \
			"$image_revision" "$REPORTING_REVISION" || {
		echo 'Active Reporting revision is unknown, divergent or newer than the full deployment.' >&2
		return 1
	}
	[[ "$health" == 'healthy' && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$app_revision" == "$image_revision" && "$restart_count" == '0' &&
		"$process_role" == 'all' && "$listen_host" == '127.0.0.1' &&
		"$scheduler_enabled" == "$expected_scheduler" ]] && {
		printf '%s' "$response" |
			grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$image_revision\""
	} || {
		echo 'Active Reporting runtime failed exact image, config, health or restart verification.' >&2
		return 1
	}
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		[[ "$scheduler_enabled" == 'false' ]] || return 1
		return 0
	fi
	reporting_cutover_validate_marker || return 1
	phase="$(reporting_cutover_marker_value phase)"
	phase_index="$(reporting_cutover_phase_index "$phase")"
	migrated_index="$(reporting_cutover_phase_index migrated)"
	scheduler_index="$(reporting_cutover_phase_index scheduler-switched)"
	if ((phase_index >= scheduler_index)); then
		reporting_cutover_require_switch_generation REPORTING
		reporting_cutover_schedule_authority_generation REPORTING REPORTING >/dev/null
		reporting_cutover_require_telegram_topic_split REPORTING
	elif ((phase_index >= migrated_index)); then
		reporting_cutover_schedule_authority_generation CORE CORE_SHADOW >/dev/null
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
	fi
}

verify_cutover_candidate_heartbeats() {
	local started_at="$1"
	local required_services="${2:-outbox-publisher,integration-worker,maintenance-worker}"

	if [[ -z "$started_at" ]]; then
		echo "Forward candidate heartbeat verification requires a start boundary." >&2
		return 1
	fi
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		-e "CUTOVER_CANDIDATE_STARTED_AT=$started_at" \
		-e "CUTOVER_REQUIRED_HEARTBEATS=$required_services" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.DATABASE_URL_PRODUCTION,
		},
	},
});
const required = String(process.env.CUTOVER_REQUIRED_HEARTBEATS || "")
	.split(",")
	.map(value => value.trim())
	.filter(Boolean);
if (!required.length) {
	throw new Error("candidate heartbeat list is empty");
}
const startedAtMs = Date.parse(
	process.env.CUTOVER_CANDIDATE_STARTED_AT || "",
);
if (!Number.isFinite(startedAtMs)) {
	throw new Error("invalid forward candidate heartbeat boundary");
}
const freshAfter = new Date(
	Math.max(startedAtMs, Date.now() - 30_000),
);

prisma.messagingHeartbeat
	.findMany({
		where: {
			service: { in: required },
			lastSeenAt: { gte: freshAfter },
		},
		select: { service: true },
	})
	.then(rows => {
		const active = new Set(rows.map(row => row.service));
		const missing = required.filter(service => !active.has(service));
		if (missing.length) {
			throw new Error(`missing candidate heartbeat: ${missing.join(",")}`);
		}
		process.stdout.write("Forward candidate heartbeats verified\n");
	})
	.catch(() => {
		process.stderr.write(
			"Forward candidate messaging heartbeats are incomplete\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
	'
}

verify_notification_cutover_containers() {
	local expected_revision="$1"
	shift
	local service
	local container_id
	local image_revision
	local restart_count

	for service in "$@"; do
		container_id="$(
			compose_notification_cutover ps --status running -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Forward cutover service is not running exactly once: $service" >&2
			return 1
		fi
		image_revision="$(
			docker inspect \
				--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$image_revision" != "$expected_revision" ]]; then
			echo "Forward cutover service has an unexpected image revision: $service" >&2
			return 1
		fi
		restart_count="$(
			docker inspect --format '{{ .RestartCount }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$restart_count" != "0" ]]; then
			echo "Forward cutover service restarted before verification: $service restartCount=${restart_count:-unknown}" >&2
			return 1
		fi
	done
}

verify_notification_cutover_candidate_containers() {
	verify_notification_cutover_containers \
		"$1" \
		"${notification_cutover_candidate_services[@]}"
}

verify_notification_cutover_pre_marker_containers() {
	verify_notification_cutover_containers \
		"$1" \
		"${notification_cutover_pre_marker_services[@]}"
}

verify_notification_cutover_pre_marker_topology() {
	local expected_revision="$1"
	local started_at="$2"
	local attempt

	if ! verify_notification_cutover_pre_marker_containers \
		"$expected_revision"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$HEALTHCHECK_URL" "$expected_revision" \
		"Pre-marker candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_readiness \
		"$READINESS_URL" "Pre-marker candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$MAINTENANCE_READINESS_URL" "$expected_revision" \
		"Pre-marker candidate Maintenance worker"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$NOTIFICATION_DELIVERY_READINESS_URL" "$expected_revision" \
		"Pre-marker candidate Notification Delivery"; then
		return 1
	fi
	if ! verify_notification_delivery_control_smoke; then
		return 1
	fi
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_cutover_candidate_heartbeats \
			"$started_at" \
			"integration-worker,maintenance-worker"; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Pre-marker candidate RabbitMQ ownership was not established." >&2
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	if ! notification_cutover_is_clear; then
		echo "Moved queues or legacy delivery state changed during pre-marker verification." >&2
		return 1
	fi
	if ! notification_delivery_service_state_is_empty; then
		echo "Notification Delivery created service-owned state before the durable marker." >&2
		echo "Service state (receipts failures outbox): ${notification_cutover_last_service_state:-unavailable}" >&2
		return 1
	fi
	verify_notification_cutover_pre_marker_containers "$expected_revision"
}

verify_notification_cutover_candidate_topology() {
	local expected_revision="$1"
	local started_at="$2"
	local attempt

	if ! verify_notification_cutover_candidate_containers \
		"$expected_revision"; then
		return 1
	fi

	if ! wait_for_cutover_revision \
		"$HEALTHCHECK_URL" "$expected_revision" \
		"Forward candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$PUBLIC_HEALTHCHECK_URL" "$expected_revision" \
		"Forward candidate public API"; then
		return 1
	fi
	if ! wait_for_cutover_readiness \
		"$READINESS_URL" "Forward candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_readiness \
		"$GATEWAY_READINESS_URL" "Forward candidate API Gateway"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$MAINTENANCE_READINESS_URL" "$expected_revision" \
		"Forward candidate Maintenance worker"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$NOTIFICATION_DELIVERY_READINESS_URL" "$expected_revision" \
		"Forward candidate Notification Delivery"; then
		return 1
	fi
	if ! verify_notification_delivery_control_smoke; then
		return 1
	fi
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_cutover_candidate_heartbeats "$started_at"; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			if ! verify_notification_cutover_candidate_containers \
				"$expected_revision"; then
				return 1
			fi
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "Forward candidate RabbitMQ ownership was not established." >&2
	return 1
}

restore_forward_cutover_on_exit() {
	local status=$?
	local recovery_failed=false
	local recovery_started_at

	trap - EXIT INT TERM
	if [[ "$forward_cutover_recovery_active" != "true" ]]; then
		exit "$status"
	fi

	set +e
	echo "Canonical handoff failed after the durable marker; restoring the saved forward topology." >&2
	if ! compose_target stop --timeout 30 \
		api-gateway \
		api \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker >/dev/null 2>&1; then
		recovery_failed=true
	fi
	recovery_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	if ! start_notification_cutover_services outbox-publisher >/dev/null; then
		recovery_failed=true
	fi
	if ! wait_for_rabbitmq_topology >/dev/null 2>&1; then
		recovery_failed=true
	fi
	if ! start_notification_cutover_services \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api >/dev/null; then
		recovery_failed=true
	fi
	if ! wait_for_cutover_revision \
		"$HEALTHCHECK_URL" \
		"$notification_cutover_marker_revision" \
		"Restored forward candidate API" >/dev/null 2>&1; then
		recovery_failed=true
	fi
	if ! start_notification_cutover_services api-gateway >/dev/null; then
		recovery_failed=true
	fi
	if ! verify_notification_cutover_candidate_topology \
		"$notification_cutover_marker_revision" \
		"$recovery_started_at"; then
		recovery_failed=true
	fi

	if [[ "$recovery_failed" == "true" ]]; then
		echo "CRITICAL: saved forward topology could not be restored completely; keep the durable marker and repair forward." >&2
	else
		echo "Saved forward topology is running; retry the full deployment to canonicalize it." >&2
	fi
	exit "$status"
}

perform_notification_first_cutover_preflight() {
	local legacy_integration_container_id
	local service
	local container_id
	local initial_database_state
	local unresolved_failures
	local active_receipts
	local pending_outbox
	local attempt

	if [[ "$notification_delivery_first_cutover" != "true" ]]; then
		return
	fi

	legacy_integration_container_id="$(
		compose_target ps --status running -q integration-worker
	)"
	if [[ -z "$legacy_integration_container_id" ||
		"$legacy_integration_container_id" == *$'\n'* ]]; then
		echo "Exactly one running legacy integration-worker is required for the first notification delivery cutover." >&2
		print_notification_cutover_runbook
		return 1
	fi
	first_cutover_legacy_worker_id="$legacy_integration_container_id"
	first_cutover_legacy_notification_worker_id="$(
		compose_target ps --status running -q notification-delivery-worker
	)"
	if [[ -z "$first_cutover_legacy_notification_worker_id" ||
		"$first_cutover_legacy_notification_worker_id" == *$'\n'* ]]; then
		echo "Exactly one running v1 Notification Delivery worker is required for the Telegram cutover." >&2
		print_notification_cutover_runbook
		return 1
	fi

	assert_cutover_rabbitmq_topology
	wait_for_rabbitmq_topology
	if ! notification_cutover_consumers_ready; then
		print_notification_cutover_runbook
		return 1
	fi
	if ! verify_exact_worker_consumer_ownership false legacy; then
		echo "The moved queues are not owned exclusively by the exact legacy integration connection." >&2
		print_notification_cutover_runbook
		return 1
	fi

	initial_database_state="$(notification_cutover_database_state)"
	IFS=$'\t' read -r unresolved_failures active_receipts pending_outbox \
		<<<"$initial_database_state"
	if [[ ! "$unresolved_failures" =~ ^[0-9]+$ ||
		! "$active_receipts" =~ ^[0-9]+$ ||
		! "$pending_outbox" =~ ^[0-9]+$ ]]; then
		echo "Public delivery state returned an invalid provider-cutover result." >&2
		print_notification_cutover_runbook
		return 1
	fi
	if [[ "$unresolved_failures" != "0" ]]; then
		echo "First cutover is blocked by $unresolved_failures unresolved public delivery failure(s)." >&2
		print_notification_cutover_runbook
		return 1
	fi
	for service in \
		outbox-publisher \
		api \
		api-gateway \
		maintenance-worker \
		campaigns-service; do
		container_id="$(
			compose_target ps --status running -q "$service"
		)"
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Exactly one running $service is required before the Telegram cutover." >&2
			print_notification_cutover_runbook
			return 1
		fi
		first_cutover_producer_ids+=("$container_id")
	done

	echo "Notification Delivery provider cutover: stopping producers and draining legacy provider work."
	first_cutover_recovery_active=true
	trap restore_first_cutover_producers_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	compose_target stop api-gateway
	compose_target stop api
	compose_target stop maintenance-worker
	compose_target stop campaigns-service

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if notification_cutover_is_clear; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Legacy notification queues did not reach a safe empty boundary." >&2
			echo "Queue state (name ready unacknowledged consumers):" >&2
			echo "$notification_cutover_last_queue_state" >&2
			echo "Database state (unresolved_failures active_receipts): ${notification_cutover_last_database_state:-unavailable}" >&2
			print_notification_cutover_runbook
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	compose_target stop outbox-publisher
	if ! notification_cutover_is_clear; then
		echo "Moved Telegram state changed while stopping the legacy Outbox publisher." >&2
		echo "$notification_cutover_last_queue_state" >&2
		print_notification_cutover_runbook
		return 1
	fi

	compose_target stop integration-worker
	if ! notification_cutover_is_clear; then
		echo "Moved notification state changed while stopping the legacy integration-worker." >&2
		echo "$notification_cutover_last_queue_state" >&2
		print_notification_cutover_runbook
		return 1
	fi
	compose_target stop notification-delivery-worker

	echo "Notification Delivery Telegram cutover boundary is quiescent and verified."
}

reporting_runtime_container_before="$(
	compose_target ps -a -q reporting-service 2>/dev/null || true
)"
if [[ "$reporting_runtime_container_before" =~ ^[0-9a-f]{64}$ ]]; then
	reporting_runtime_image_before="$(
		docker inspect --format '{{.Image}}' "$reporting_runtime_container_before"
	)"
elif [[ -z "$reporting_runtime_container_before" ]]; then
	reporting_runtime_container_before='absent'
	reporting_runtime_image_before=''
else
	reporting_runtime_image_before=''
fi
reporting_cleanup_runtime_deploy=false
reporting_cleanup_migration_state='not-applicable'
if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
	reporting_cutover_validate_marker || exit 1
	if [[ "$(reporting_cutover_marker_value phase)" == 'cleanup-staged' &&
		"$(reporting_cutover_marker_value cleanup_revision)" == "$APP_REVISION" ]]; then
		reporting_cleanup_migration_state="$(
			reporting_cutover_core_cleanup_migration_state "$APP_REVISION"
		)" || exit 1
		case "$reporting_cleanup_migration_state" in
		pending | applied) ;;
		unfinished-transition | unfinished-steady)
			echo 'Reporting cleanup has an exact unfinished Prisma attempt; keep writers stopped and use the separately reviewed resolve procedure.' >&2
			exit 1
			;;
		*)
			echo 'Reporting cleanup migration ledger/schema/checksum state is unsafe.' >&2
			exit 1
			;;
		esac
		reporting_cleanup_runtime_deploy=true
		if [[ "$reporting_cleanup_migration_state" == 'pending' ]]; then
			echo 'Exact staged cleanup will stop or adopt the pinned rollback containers before the Core migration.'
		else
			echo 'Exact cleanup migration is already applied; all old writers are fenced and recovery is forward-only.'
		fi
	fi
fi
if [[ "$reporting_cleanup_runtime_deploy" != 'true' &&
	"$reporting_interrupted_routine_recovery" != 'true' &&
	"$billing_core_cleanup_runtime_deploy" != 'true' ]]; then
	verify_active_reporting_runtime \
		"$reporting_runtime_container_before" \
		"$reporting_runtime_image_before" || {
		echo 'Reporting runtime preflight failed before any database migration or runtime handoff.' >&2
		exit 1
	}
fi

reporting_outcome_route_state_before="$(
	reporting_outcome_route_topology_state
)" || exit 1
if [[ "$reporting_interrupted_routine_recovery" == 'true' ]]; then
	[[ "$reporting_outcome_route_state_before" == 'forward' ||
		"$reporting_outcome_route_state_before" == 'steady' ]] || {
		echo 'Interrupted Reporting recovery lost its forward-only RabbitMQ boundary.' >&2
		exit 1
	}
	reporting_outcome_route_is_drained || exit 1
	reporting_outcome_route_queues_are_empty false || exit 1
fi
if [[ "$reporting_outcome_route_state_before" != 'steady' ]]; then
	[[ "$reporting_cleanup_runtime_deploy" != 'true' &&
		"$notification_delivery_first_cutover" != 'true' &&
		"$notification_forward_candidate_active" != 'true' &&
		"$notification_forward_candidate_needs_recovery" != 'true' ]] || {
		echo 'The Reporting outcome route split cannot overlap another production cutover or recovery.' >&2
		exit 1
	}
	reporting_outcome_route_is_drained || exit 1
	reporting_outcome_route_queues_are_empty false || exit 1
fi

if [[ "$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
	[[ "$reporting_cleanup_runtime_deploy" != 'true' &&
		"$reporting_interrupted_routine_recovery" != 'true' &&
		"$widgets_core_cleanup_runtime_deploy" != 'true' &&
		"$notification_delivery_first_cutover" != 'true' &&
		"$notification_forward_candidate_active" != 'true' &&
		"$notification_forward_candidate_needs_recovery" != 'true' ]] || {
		echo 'Billing Core source cleanup cannot overlap another production cutover or recovery.' >&2
		exit 1
	}
	[[ "$reporting_outcome_route_state_before" == 'steady' ]] || {
		echo 'Billing Core cleanup requires the already-completed steady Reporting outcome topology.' >&2
		exit 1
	}
	billing_core_source_cleanup_validate_marker || exit 1
	billing_core_cleanup_require_bound_pre_evidence || exit 1
	billing_core_cleanup_require_pinned_images || exit 1
	billing_core_cleanup_validate_staged_manifests || exit 1
	if [[ "$billing_core_cleanup_source_state" == 'present' ]]; then
		billing_core_cleanup_require_staged_broker=true
		billing_core_cleanup_require_broker_identity || exit 1
	else
		billing_core_cleanup_require_staged_broker=false
	fi
	echo 'Pinned Billing Core source cleanup evidence and images were revalidated before runtime stop.'
fi

if [[ "$widgets_core_cleanup_runtime_deploy" == 'true' ]]; then
	[[ "$reporting_cleanup_runtime_deploy" != 'true' &&
		"$reporting_interrupted_routine_recovery" != 'true' &&
		"$notification_delivery_first_cutover" != 'true' &&
		"$notification_forward_candidate_active" != 'true' &&
		"$notification_forward_candidate_needs_recovery" != 'true' ]] || {
		echo 'Widgets Core source cleanup cannot overlap another production cutover or recovery.' >&2
		exit 1
	}
	widgets_core_cleanup_revalidate_boundary || exit 1
	echo 'Pinned Widgets Core source cleanup evidence was revalidated before service migrations and runtime stop.'
fi

if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
	[[ "$notification_delivery_first_cutover" != 'true' &&
		"$notification_forward_candidate_active" != 'true' &&
		"$notification_forward_candidate_needs_recovery" != 'true' ]] || {
		echo 'Reporting cleanup cannot overlap a Notification Delivery cutover or recovery.' >&2
		exit 1
	}
	echo 'Pinned Reporting cleanup revision skips already-completed service migrations; its reviewed Git contract permits only the exact Core cleanup migration.'
else
verify_notification_delivery_migration_boundary
if [[ "$notification_forward_candidate_active" == "true" ]]; then
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps notification-delivery-migrate \
		migrate status \
		--schema prisma/schema.prisma
else
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps notification-delivery-migrate
fi
finalize_notification_delivery_backup_grants
verify_notification_delivery_runtime_crud
verify_notification_delivery_backup_boundary
if [[ "$reporting_interrupted_routine_recovery" == 'true' ||
	"$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
	current_campaigns_container_id="$(
		compose_target ps -a -q campaigns-service 2>/dev/null || true
	)"
else
	current_campaigns_container_id="$(
		compose_target ps --status running -q campaigns-service 2>/dev/null || true
	)"
fi
[[ -n "$current_campaigns_container_id" &&
	"$current_campaigns_container_id" != *$'\n'* ]] || {
	echo "Routine full deploy requires one canonical Campaigns service container." >&2
	exit 1
}
current_campaigns_revision="$(
	docker image inspect \
		--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$(docker inspect --format '{{.Image}}' "$current_campaigns_container_id")"
)"
[[ "$current_campaigns_revision" =~ ^[0-9a-f]{40}$ ]] ||
	{
		echo "Current Campaigns image revision is invalid." >&2
		exit 1
	}
git -C "$server_root" merge-base --is-ancestor \
	"$current_campaigns_revision" "$CAMPAIGNS_REVISION" || {
	echo "Routine full deploy does not accept divergent Campaigns history." >&2
	exit 1
}
changed_campaigns_migrations="$(
	git -C "$server_root" diff --name-only \
		"$current_campaigns_revision" "$CAMPAIGNS_REVISION" -- \
		'apps/campaigns/prisma/migrations/*/migration.sql'
)"
while IFS= read -r migration; do
	[[ -z "$migration" ]] && continue
	if git -C "$server_root" diff --unified=0 \
		"$current_campaigns_revision" "$CAMPAIGNS_REVISION" -- "$migration" |
		sed -n 's/^+//p' |
		grep -Eiq \
			'(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]|RENAME[[:space:]]|ALTER[[:space:]]+COLUMN|SET[[:space:]]+NOT[[:space:]]+NULL|DROP[[:space:]]+NOT[[:space:]]+NULL'; then
		echo "Routine full deploy found a breaking Campaigns migration: $migration" >&2
		echo "Use a separately reviewed coordinated Campaigns migration plan." >&2
		exit 1
	fi
done <<<"$changed_campaigns_migrations"
if [[ -n "$changed_campaigns_migrations" ]]; then
	create_campaigns_pre_migration_backup
fi
compose_target \
	--profile campaigns-migration \
	run --rm --no-deps campaigns-migrate
verify_campaigns_database_access_boundaries
compose_target \
	--profile widgets-migration \
	run --rm --no-deps widgets-migrate
compose_target \
	--profile identity-migration \
	run --rm --no-deps identity-migrate
compose_target \
	--profile support-migration \
	run --rm --no-deps support-migrate
verify_support_steady_ownership || {
	echo 'Routine deployment requires an already completed, anchor-identical Support ownership switch.' >&2
	echo 'Run the separate guarded Support cutover lifecycle; routine deploy never activates ownership.' >&2
	exit 1
}
docker run --rm --network host --env-file "$ENV_FILE" \
	--entrypoint node "$WIDGETS_IMAGE" \
	dist/src/cutover-main.js verify-steady >/dev/null

if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	if ! compose_target --profile migration run --rm --no-deps \
		migrate migrate status; then
		echo "The first notification cutover cannot carry a pending core schema migration." >&2
		echo "Deploy the core expand migration separately, then rerun the full cutover." >&2
		exit 1
	fi
fi

perform_notification_first_cutover_preflight

if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	assert_cutover_rabbitmq_topology
	wait_for_rabbitmq_topology
fi

if [[ "$notification_delivery_first_cutover" != "true" ]] &&
	validate_notification_cutover_marker; then
	delete_legacy_payment_telegram_queues
fi

if [[ "$notification_forward_candidate_needs_recovery" == "true" ]]; then
	echo "Restoring the exact saved forward topology before canonical handoff."
	forward_cutover_recovery_active=true
	trap restore_forward_cutover_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	start_notification_cutover_services outbox-publisher
	wait_for_rabbitmq_topology
	start_notification_cutover_services \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api
	wait_for_cutover_revision \
		"$HEALTHCHECK_URL" \
		"$notification_cutover_marker_revision" \
		"Recovered forward candidate API"
	start_notification_cutover_services api-gateway
	echo "Exact saved forward topology was restarted."
fi

if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	provision_rabbitmq_user \
		"$integration_user" \
		"$integration_password_base64" \
		'^$' \
		'^(winwidget\.retry|winwidget\.dead-letter)$' \
		"$post_cutover_integration_read_pattern" \
		''
	echo "Integration RabbitMQ read permissions were narrowed after the verified Telegram cutover boundary."

	notification_cutover_candidate_started_at="$(
		date -u +'%Y-%m-%dT%H:%M:%S.%3NZ'
	)"
	first_cutover_candidate_started=true
	# Production Compose does not support --no-deps on `create`.
	# `up --no-start` pre-creates the two post-marker services in isolation.
	compose_notification_cutover up \
		--no-start \
		--no-deps \
		--force-recreate \
		outbox-publisher \
		api-gateway
	compose_notification_cutover up \
		-d \
		--no-deps \
		--force-recreate \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api

	verify_notification_cutover_pre_marker_topology \
		"$APP_REVISION" \
		"$notification_cutover_candidate_started_at"

	umask 077
	first_cutover_marker_tmp="$(
		mktemp "${NOTIFICATION_DELIVERY_CUTOVER_MARKER}.tmp.XXXXXX"
	)"
	{
		printf 'revision=%s\n' "$APP_REVISION"
		printf 'created_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	} >"$first_cutover_marker_tmp"
	chmod 600 "$first_cutover_marker_tmp"
	# From this point a marker means the isolated worker/API topology was
	# verified and rollback must continue forward. Ignore termination only
	# across the atomic marker/trap state transition.
	trap '' INT TERM
	mv "$first_cutover_marker_tmp" "$NOTIFICATION_DELIVERY_CUTOVER_MARKER"
	first_cutover_marker_tmp=""
	notification_cutover_marker_revision="$APP_REVISION"
	notification_forward_candidate_active=true
	first_cutover_recovery_active=false
	echo "Durable notification delivery cutover marker created before enabling producers or public traffic."
	# Keep every producer stopped until the legacy payment queue and its
	# payment.succeeded.v1 binding are gone. If retirement fails, exit
	# fail-closed with the marker present; the next full deploy resumes forward
	# before any publisher or public Gateway is started.
	delete_legacy_payment_telegram_queues
	forward_cutover_recovery_active=true
	trap restore_forward_cutover_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	start_notification_cutover_services outbox-publisher
	wait_for_rabbitmq_topology
	start_notification_cutover_services api-gateway
	echo "The saved cutover project stays available until canonical Compose handoff is fully verified."
fi
fi

if [[ "$notification_forward_candidate_active" == "true" ]]; then
	notification_cutover_candidate_verification_started_at="$(
		date -u +'%Y-%m-%dT%H:%M:%S.%3NZ'
	)"
	verify_notification_cutover_candidate_topology \
		"$notification_cutover_marker_revision" \
		"$notification_cutover_candidate_verification_started_at"
	forward_cutover_recovery_active=true
	trap restore_forward_cutover_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM

	echo "Canonicalizing the verified forward cutover topology service by service."
	echo "Candidate containers are retained as the post-marker recovery target until final smoke passes."
	compose_target --profile migration run --rm --no-deps migrate
	compose_target up -d rabbitmq
	messaging_readiness_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"

	# Outbox publishers are CAS-safe, so start the canonical instance before
	# pausing its saved forward counterpart.
	compose_target up -d --no-deps --force-recreate outbox-publisher
	if [[ -z "$(compose_target ps --status running -q outbox-publisher)" ]]; then
		echo "Canonical Outbox publisher did not start." >&2
		exit 1
	fi
	stop_notification_cutover_services 30 false outbox-publisher
	wait_for_rabbitmq_topology

	# The two narrow integration workers are idempotent; overlap is limited to
	# startup and ends before exact ownership is checked.
	compose_target up -d --no-deps --force-recreate integration-worker
	if [[ -z "$(compose_target ps --status running -q integration-worker)" ]]; then
		echo "Canonical integration worker did not start." >&2
		exit 1
	fi
	stop_notification_cutover_services 30 false integration-worker
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Canonical integration ownership was not established." >&2
			exit 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	stop_notification_cutover_services 30 false maintenance-worker
	compose_target up -d --no-deps --force-recreate maintenance-worker
	wait_for_cutover_revision \
		"$MAINTENANCE_READINESS_URL" \
		"$MAINTENANCE_REVISION" \
		"Canonical Maintenance worker"

	compose_target up -d --no-deps --force-recreate database-restore-worker
	wait_for_database_restore_worker

	stop_notification_cutover_services 30 false notification-delivery-worker
	compose_target up -d --no-deps --force-recreate notification-delivery-worker
	wait_for_cutover_revision \
		"$NOTIFICATION_DELIVERY_READINESS_URL" \
		"$NOTIFICATION_DELIVERY_REVISION" \
		"Canonical Notification Delivery"
	verify_notification_delivery_control_smoke
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Canonical notification ownership was not established." >&2
			exit 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	compose_target up -d --no-deps --force-recreate campaigns-service
	wait_for_cutover_revision \
		"$CAMPAIGNS_READINESS_URL" \
		"$CAMPAIGNS_REVISION" \
		"Canonical Campaigns"

	start_canonical_reporting_runtime "Canonical Reporting"
	finish_canonical_reporting_runtime "Canonical Reporting"

	compose_target up -d --no-deps --force-recreate widgets-service
	wait_for_cutover_revision \
		"$WIDGETS_READINESS_URL" \
		"$WIDGETS_REVISION" \
		"Canonical Widgets"

	compose_target up -d --no-deps --force-recreate \
		support-api support-worker support-outbox-publisher
	wait_for_cutover_revision \
		"$SUPPORT_API_READINESS_URL" "$SUPPORT_REVISION" "Canonical Support API"
	wait_for_cutover_revision \
		"$SUPPORT_WORKER_READINESS_URL" "$SUPPORT_REVISION" "Canonical Support worker"
	wait_for_cutover_revision \
		"$SUPPORT_OUTBOX_READINESS_URL" "$SUPPORT_REVISION" "Canonical Support Outbox publisher"

	stop_notification_cutover_services 30 false api
	compose_target up -d --no-deps --force-recreate api
	wait_for_cutover_revision \
		"$HEALTHCHECK_URL" "$APP_REVISION" "Canonical API"
	wait_for_cutover_readiness "$READINESS_URL" "Canonical API"

	stop_notification_cutover_services 30 false api-gateway
	compose_target up -d --no-deps --force-recreate api-gateway
	wait_for_cutover_readiness \
		"$GATEWAY_READINESS_URL" "Canonical API Gateway"
	wait_for_cutover_revision \
		"$PUBLIC_HEALTHCHECK_URL" "$APP_REVISION" "Canonical public API"
else
	if [[ "$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
		billing_core_cleanup_stop_recovery_active=true
		trap recover_billing_core_cleanup_stop_on_exit EXIT
		trap 'exit 130' INT
		trap 'exit 143' TERM
		if ! stop_billing_core_cleanup_topology; then
			echo 'Billing Core source cleanup topology did not reach an exact quiescent boundary.' >&2
			exit 1
		fi
	elif [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
		reporting_cleanup_stop_recovery_active=true
		trap recover_reporting_cleanup_stop_on_exit EXIT
		trap 'exit 130' INT
		trap 'exit 143' TERM
		if ! stop_reporting_cleanup_topology_for_core_migration \
			"$reporting_cleanup_migration_state"; then
			echo 'Reporting cleanup topology did not reach an exact quiescent recovery boundary.' >&2
			exit 1
		fi
	elif [[ "$widgets_core_cleanup_runtime_deploy" == 'true' ]]; then
		widgets_core_cleanup_stop_recovery_active=true
		trap recover_widgets_core_cleanup_stop_on_exit EXIT
		trap 'exit 130' INT
		trap 'exit 143' TERM
		widgets_core_cleanup_revalidate_boundary || exit 1
		widgets_core_cleanup_source_state="$(widgets_core_source_state)" || exit 1
		if [[ "$widgets_core_cleanup_source_state" == 'present' ]]; then
			if ! stop_widgets_core_cleanup_precommit_topology; then
				echo 'Widgets Core source cleanup topology did not reach the quiescent pre-migration boundary.' >&2
				exit 1
			fi
		else
			if ! stop_widgets_core_cleanup_topology_for_recovery; then
				echo 'Widgets Core source cleanup forward recovery could not adopt the stopped topology.' >&2
				exit 1
			fi
		fi
		widgets_core_cleanup_revalidate_boundary || exit 1
	elif [[ "$reporting_interrupted_routine_recovery" == 'true' ]]; then
		prepare_database_restore_storage
		verify_core_database_sessions_drained || {
			echo 'Interrupted Reporting recovery did not retain the quiescent Core database boundary.' >&2
			exit 1
		}
	elif ! stop_routine_topology_for_core_migration; then
		echo "Routine production topology did not reach a safe core migration boundary." >&2
		exit 1
	fi
	if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
		reporting_cutover_validate_marker || {
			if [[ "$reporting_cleanup_runtime_deploy" != 'true' &&
				"$billing_core_cleanup_runtime_deploy" != 'true' ]]; then
				restore_routine_containers_after_failed_stop || true
			fi
			exit 1
		}
		if [[ "$(reporting_cutover_marker_value phase)" == 'cleanup-staged' &&
			"$(reporting_cutover_marker_value cleanup_revision)" == "$APP_REVISION" ]]; then
			if [[ "$reporting_cleanup_migration_state" == 'pending' ]]; then
				core_cleanup_backup_gate='reporting_cutover_require_core_cleanup_backup_from_review'
			else
				core_cleanup_backup_gate='reporting_cutover_require_core_cleanup_backup_archive_from_review'
			fi
			if ! "$core_cleanup_backup_gate"; then
				echo 'Verified Core cleanup backup evidence changed, expired or no longer matches the pre-migration boundary.' >&2
				exit 1
			fi
			if ! reporting_cutover_require_cleanup_legacy_drain_after_stop; then
				echo 'Legacy Reporting drain changed at the destructive migration boundary; no migration was executed.' >&2
				exit 1
			fi
			if ! reporting_cutover_prepare_settings_topology_cleanup_after_stop; then
				echo 'Reporting settings topology could not converge at the stopped cleanup boundary.' >&2
				exit 1
			fi
		fi
	fi
		if [[ "$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
			billing_core_cleanup_require_bound_pre_evidence || exit 1
			billing_core_cleanup_require_pinned_images || exit 1
			billing_core_cleanup_source_state="$(billing_core_source_state)" || exit 1
			billing_core_cleanup_migration_state="$(
				billing_core_source_cleanup_migration_state
			)" || exit 1
			if [[ "$billing_core_cleanup_migration_state" == 'applied' ]]; then
				billing_core_source_cleanup_require_exact_migration_manifest applied
			else
				billing_core_source_cleanup_require_exact_migration_manifest exclusive
			fi || {
				echo 'Billing Core cleanup migration tree or ledger changed at the stopped boundary.' >&2
				exit 1
			}
			if [[ "$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" == \
				'present|unfinished' ]]; then
				compose_target --profile migration run --rm --no-deps migrate \
					migrate resolve --rolled-back \
					"$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
				billing_core_cleanup_migration_state="$(
					billing_core_source_cleanup_migration_state
				)" || exit 1
				[[ "$billing_core_cleanup_migration_state" == 'rolled-back' ]] || exit 1
			fi
			if [[ "$billing_core_cleanup_source_state" == 'present' &&
				"$billing_core_cleanup_migration_state" =~ ^(pending|rolled-back)$ ]]; then
				billing_core_cleanup_database_url="$(
					billing_core_source_cleanup_migration_url_from_marker
				)" || exit 1
				if ! DATABASE_URL="$billing_core_cleanup_database_url" \
					compose_target --profile migration run --rm --no-deps \
						-e DATABASE_URL migrate; then
					unset billing_core_cleanup_database_url
					billing_core_cleanup_source_state="$(billing_core_source_state 2>/dev/null || printf 'unknown')"
					billing_core_cleanup_migration_state="$(
						billing_core_source_cleanup_migration_state 2>/dev/null || printf 'unsafe'
					)"
					if [[ "$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" == \
						'absent|unfinished' ]]; then
						compose_target --profile migration run --rm --no-deps migrate \
							migrate resolve --applied \
							"$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
					elif [[ "$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" != \
						'absent|applied' ]]; then
						echo "Billing Core cleanup migrate failed before a provable forward boundary: source=$billing_core_cleanup_source_state migration=$billing_core_cleanup_migration_state." >&2
						exit 1
					fi
				fi
				unset billing_core_cleanup_database_url
			elif [[ "$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" == \
				'absent|unfinished' ]]; then
				compose_target --profile migration run --rm --no-deps migrate \
					migrate resolve --applied \
					"$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
			elif [[ "$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" == \
				'absent|applied' ]]; then
				echo 'Billing Core source cleanup migration is already applied; continuing forward.'
			else
				echo "Billing Core source cleanup cannot continue from source=$billing_core_cleanup_source_state migration=$billing_core_cleanup_migration_state." >&2
				exit 1
			fi
			billing_core_cleanup_source_state="$(billing_core_source_state)" || exit 1
			billing_core_cleanup_migration_state="$(
				billing_core_source_cleanup_migration_state
			)" || exit 1
			[[ "$billing_core_cleanup_source_state|$billing_core_cleanup_migration_state" == \
				'absent|applied' ]] || {
				echo "Billing Core cleanup did not reach absent|applied: source=$billing_core_cleanup_source_state migration=$billing_core_cleanup_migration_state." >&2
				exit 1
			}
			billing_core_cleanup_delete_retired_outcome_queues || {
				echo 'Legacy Core notification outcome queue retirement failed.' >&2
				exit 1
			}
			compose_target --profile migration run --rm --no-deps migrate || {
				echo 'A migration command failed after the Billing cleanup boundary; forward recovery remains stopped.' >&2
				exit 1
			}
			billing_core_source_cleanup_require_exact_migration_manifest applied || {
				echo 'Billing Core cleanup did not leave the exact migration tree fully applied.' >&2
				exit 1
			}
			billing_core_source_cleanup_advance_applied || exit 1
			echo 'Billing Core legacy source and obsolete outcome queues reached the durable forward-only boundary.'
		elif [[ "$reporting_cleanup_runtime_deploy" == 'true' &&
			"$reporting_cleanup_migration_state" == 'applied' ]]; then
			echo 'Exact Core cleanup migration is already applied; Prisma deploy is skipped during forward-only recovery.'
		elif [[ "$widgets_core_cleanup_runtime_deploy" == 'true' ]]; then
			widgets_core_cleanup_source_state="$(widgets_core_source_state)" || exit 1
			widgets_core_cleanup_migration_state="$(widgets_core_source_cleanup_migration_state)" || exit 1
			if [[ "$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" == \
				'present|unfinished' ]]; then
				compose_target --profile migration run --rm --no-deps migrate \
					migrate resolve --rolled-back "$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
				widgets_core_cleanup_migration_state="$(widgets_core_source_cleanup_migration_state)" || exit 1
				[[ "$widgets_core_cleanup_migration_state" == 'rolled-back' ]] || exit 1
			fi
			if [[ "$widgets_core_cleanup_source_state" == 'present' &&
				"$widgets_core_cleanup_migration_state" =~ ^(pending|rolled-back)$ ]]; then
				widgets_core_cleanup_database_url="$(widgets_core_cleanup_migration_url)" || exit 1
				if ! DATABASE_URL="$widgets_core_cleanup_database_url" \
					compose_target --profile migration run --rm --no-deps \
						-e DATABASE_URL migrate; then
					unset widgets_core_cleanup_database_url
					widgets_core_cleanup_source_state="$(widgets_core_source_state 2>/dev/null || printf 'unknown')"
					widgets_core_cleanup_migration_state="$(widgets_core_source_cleanup_migration_state 2>/dev/null || printf 'unsafe')"
					if [[ "$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" == \
						'absent|unfinished' ]]; then
						compose_target --profile migration run --rm --no-deps migrate \
							migrate resolve --applied "$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
					elif [[ "$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" != \
						'absent|applied' ]]; then
						echo "Widgets Core cleanup migrate failed before a provable forward boundary: source=$widgets_core_cleanup_source_state migration=$widgets_core_cleanup_migration_state." >&2
							exit 1
					fi
				fi
				unset widgets_core_cleanup_database_url
			elif [[ "$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" == \
				'absent|unfinished' ]]; then
				compose_target --profile migration run --rm --no-deps migrate \
					migrate resolve --applied "$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
			elif [[ "$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" == \
				'absent|applied' ]]; then
				echo 'Widgets Core source cleanup migration is already applied; continuing forward.'
			else
				echo "Widgets Core source cleanup cannot continue from source=$widgets_core_cleanup_source_state migration=$widgets_core_cleanup_migration_state." >&2
				exit 1
			fi
			widgets_core_cleanup_source_state="$(widgets_core_source_state)" || exit 1
			widgets_core_cleanup_migration_state="$(widgets_core_source_cleanup_migration_state)" || exit 1
			[[ "$widgets_core_cleanup_source_state|$widgets_core_cleanup_migration_state" == 'absent|applied' ]] || {
				echo "Widgets Core cleanup did not reach absent|applied: source=$widgets_core_cleanup_source_state migration=$widgets_core_cleanup_migration_state." >&2
				exit 1
			}
			widgets_core_source_cleanup_advance_marker applied pending pending || exit 1
			echo 'Widgets Core legacy source tables were removed and the exact Prisma ledger is applied.'
		elif ! compose_target --profile migration run --rm --no-deps migrate; then
		if [[ "$reporting_cleanup_runtime_deploy" != 'true' ]]; then
			exit 1
		fi
		reporting_cleanup_migration_state="$(
			reporting_cutover_core_cleanup_migration_state "$APP_REVISION" 2>/dev/null ||
				printf 'unsafe\n'
		)"
		if [[ "$reporting_cleanup_migration_state" != 'applied' ]]; then
			echo "Core cleanup migrate failed with post-command state=$reporting_cleanup_migration_state; recovery remains fail-closed." >&2
			exit 1
		fi
		echo 'Prisma command failed after the exact cleanup migration became applied; continuing forward without restoring old writers.' >&2
	fi
	if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
		reporting_cleanup_migration_state="$(
			reporting_cutover_core_cleanup_migration_state "$APP_REVISION"
		)" || exit 1
		[[ "$reporting_cleanup_migration_state" == 'applied' ]] || {
			echo "Cleanup Reporting cannot start until the exact migration state is applied; got $reporting_cleanup_migration_state." >&2
			exit 1
		}
	fi
	if [[ "$billing_core_cleanup_marker_phase" == 'complete' ]]; then
		billing_require_core_source_absent &&
			billing_core_source_cleanup_require_exact_migration_manifest applied || {
			echo 'Routine migration recreated or changed the completed Billing Core cleanup boundary.' >&2
			exit 1
		}
		billing_core_cleanup_require_retired_outcome_absent || {
			echo 'Retired Core notification outcome topology reappeared during routine migration.' >&2
			exit 1
		}
	fi
	if ! prepare_reporting_outcome_route_cutover_after_stop; then
		echo 'Reporting outcome routing could not reach the forward-safe boundary.' >&2
		exit 1
	fi
	compose_target up -d rabbitmq
	messaging_readiness_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	reporting_start_failed=false
	if ! start_canonical_reporting_runtime "Reporting"; then
		reporting_start_failed=true
	fi
	compose_target up -d --no-deps --force-recreate outbox-publisher
	compose_target up -d --no-deps --force-recreate \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker \
		campaigns-service \
		widgets-service \
		support-api \
		support-worker \
		support-outbox-publisher
	compose_target up -d --no-deps --force-recreate api
	compose_target up -d --no-deps --force-recreate \
		identity-api \
		identity-worker \
		identity-outbox-publisher
	wait_for_cutover_revision \
		"$IDENTITY_API_READINESS_URL" "$IDENTITY_REVISION" "Identity API"
	wait_for_cutover_revision \
		"$IDENTITY_WORKER_READINESS_URL" "$IDENTITY_REVISION" "Identity worker"
	wait_for_cutover_revision \
		"$IDENTITY_OUTBOX_READINESS_URL" "$IDENTITY_REVISION" "Identity Outbox publisher"
	wait_for_cutover_revision \
		"$SUPPORT_API_READINESS_URL" "$SUPPORT_REVISION" "Support API"
	wait_for_cutover_revision \
		"$SUPPORT_WORKER_READINESS_URL" "$SUPPORT_REVISION" "Support worker"
	wait_for_cutover_revision \
		"$SUPPORT_OUTBOX_READINESS_URL" "$SUPPORT_REVISION" "Support Outbox publisher"
	compose_target up -d --no-deps --force-recreate api-gateway
	core_runtime_recovered=true
	if ! wait_for_cutover_revision \
		"$HEALTHCHECK_URL" "$APP_REVISION" "Recovered canonical API"; then
		core_runtime_recovered=false
	fi
	if ! wait_for_cutover_readiness \
		"$READINESS_URL" "Recovered canonical API"; then
		core_runtime_recovered=false
	fi
	if ! wait_for_cutover_readiness \
		"$GATEWAY_READINESS_URL" "Recovered canonical API Gateway"; then
		core_runtime_recovered=false
	fi
	if [[ "$core_runtime_recovered" != 'true' ]]; then
		echo 'Canonical API, Gateway or workers did not recover after the Reporting outcome handoff.' >&2
		exit 1
	fi
	if [[ "$reporting_start_failed" == 'true' ]]; then
		echo 'Reporting failed to launch; canonical API, Gateway and workers were restored and verified.' >&2
		exit 1
	fi
	if ! finish_canonical_reporting_runtime "Reporting"; then
		echo 'Reporting failed readiness; canonical API, Gateway and workers remain ready.' >&2
		exit 1
	fi
	if ! wait_for_cutover_revision \
		"$WIDGETS_READINESS_URL" "$WIDGETS_REVISION" "Widgets"; then
		echo 'Widgets failed readiness after the canonical runtime handoff.' >&2
		exit 1
	fi
	wait_for_rabbitmq_topology
fi

verify_billing_rabbitmq_consumers() {
	local container_id vhost expected_active
	container_id="$(compose_target ps --status running -q rabbitmq)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	vhost="$(get_env_value RABBITMQ_VHOST)"
	expected_active='false'
	if [[ "$billing_database_phase" == 'active' ||
		"$billing_database_phase" == 'complete' ]]; then
		expected_active='true'
	fi
	docker exec "$container_id" rabbitmqctl --silent list_queues -p "$vhost" \
		name consumers | BILLING_EXPECT_ACTIVE="$expected_active" billing_release_node_stdin -e '
const fs = require("node:fs");
const rows = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean)
  .map(line => line.trim().split(/\s+/));
const queues = new Map(rows.map(([name, consumers]) => [name, Number(consumers)]));
const source = [
  "winwidget.billing.identity.v1",
  "winwidget.billing.notification-routing.v1",
  "winwidget.billing.trial.v1",
  "winwidget.billing.referral.v1",
  "winwidget.billing.offer.v2",
  "winwidget.billing.lifecycle-repair.v1",
];
const retired = "winwidget.billing.settings-source.v1";
for (const suffix of ["", ".retry.1", ".retry.2", ".retry.3", ".dead-letter"])
  if (queues.has(`${retired}${suffix}`)) process.exit(1);
const active = [
  "winwidget.payment.auto-renewal",
  "winwidget.billing.notification-delivery-outcome",
];
const all = [...source, ...active];
for (const queue of all) {
  for (const suffix of ["", ".retry.1", ".retry.2", ".retry.3", ".dead-letter"])
    if (!queues.has(`${queue}${suffix}`)) process.exit(1);
}
if (source.some(queue => queues.get(queue) !== 1)) process.exit(1);
if (process.env.BILLING_EXPECT_ACTIVE === "true") {
  if (active.some(queue => queues.get(queue) !== 1)) process.exit(1);
} else {
  if (queues.get("winwidget.payment.auto-renewal") !== 1 ||
      queues.get("winwidget.billing.notification-delivery-outcome") !== 0)
    process.exit(1);
}
'
}

compose_target up -d --no-deps --force-recreate \
	billing-api \
	billing-worker \
	billing-outbox-publisher
if [[ "$billing_database_phase" == 'active' ||
	"$billing_database_phase" == 'complete' ]]; then
	compose_target up -d --no-deps --force-recreate billing-scheduler
else
	compose_target stop --timeout 90 billing-scheduler >/dev/null 2>&1 || true
fi
wait_for_cutover_revision \
	"$BILLING_API_READINESS_URL" "$BILLING_REVISION" "Billing API"
wait_for_cutover_revision \
	"$BILLING_WORKER_READINESS_URL" "$BILLING_REVISION" "Billing worker"
wait_for_cutover_revision \
	"$BILLING_OUTBOX_READINESS_URL" "$BILLING_REVISION" "Billing Outbox publisher"
if [[ "$billing_database_phase" == 'active' ||
	"$billing_database_phase" == 'complete' ]]; then
	wait_for_cutover_revision \
		"$BILLING_SCHEDULER_READINESS_URL" "$BILLING_REVISION" \
		"Billing scheduler"
fi
for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if verify_billing_rabbitmq_consumers; then
		break
	fi
	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo 'Billing RabbitMQ consumer ownership verification failed.' >&2
		exit 1
	fi
	sleep "$HEALTHCHECK_INTERVAL"
done

show_api_diagnostics() {
	echo "API deployment diagnostics:"
	compose_target \
		ps api-gateway api outbox-publisher integration-worker maintenance-worker database-restore-worker notification-delivery-worker campaigns-service reporting-service widgets-service billing-api billing-scheduler billing-worker billing-outbox-publisher identity-api identity-worker identity-outbox-publisher support-api support-worker support-outbox-publisher rabbitmq || true
	compose_target \
		logs --tail=100 api-gateway api outbox-publisher integration-worker maintenance-worker database-restore-worker notification-delivery-worker campaigns-service reporting-service widgets-service billing-api billing-scheduler billing-worker billing-outbox-publisher identity-api identity-worker identity-outbox-publisher support-api support-worker support-outbox-publisher rabbitmq || true
	echo "Processes listening on ports 4100, 4200, 4300, 4401, 4500, 4600, 4700, 4800-4803, 4900-4902 and 5100-5102:"
	ss -ltnp \
		'( sport = :4100 or sport = :4200 or sport = :4300 or sport = :4401 or sport = :4500 or sport = :4600 or sport = :4700 or sport = :4800 or sport = :4801 or sport = :4802 or sport = :4803 or sport = :4900 or sport = :4901 or sport = :4902 or sport = :5100 or sport = :5101 or sport = :5102 )' ||
		true
}

ensure_required_services_running() {
	local service
	local container_id
	for service in \
		rabbitmq \
		api \
		api-gateway \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker \
		campaigns-service \
		reporting-service \
		widgets-service \
		"${identity_runtime_services[@]}" \
		"${billing_runtime_services[@]}" \
		"${support_runtime_services[@]}"; do
		container_id="$(
			compose_target ps --status running -q "$service"
		)"
		if [[ -z "$container_id" ]]; then
			echo "Required service is not running: $service" >&2
			show_api_diagnostics
			exit 1
		fi
	done
}

check_deployment_revision() {
	local url="$1"
	local response
	response="$(
		curl -fsS --connect-timeout 3 --max-time 5 \
			-H 'Cache-Control: no-cache' "$url" || true
	)"

	if [[ "$response" == *"\"revision\":\"$APP_REVISION\""* ]]; then
		return 0
	fi

	if [[ -n "$response" ]]; then
		echo "Unexpected deployment health response from $url: $response"
	fi
	return 1
}

check_messaging_readiness() {
	local billing_owner_active='false'
	if [[ "$billing_database_phase" == 'active' ||
		"$billing_database_phase" == 'complete' ]]; then
		billing_owner_active='true'
	fi
	compose_target exec -T \
		-e "MESSAGING_READINESS_STARTED_AT=$messaging_readiness_started_at" \
		-e "BILLING_OWNER_ACTIVE=$billing_owner_active" \
		-e "INTEGRATION_WORKER_KINDS=$(get_env_value INTEGRATION_WORKER_KINDS)" \
		-e "MAINTENANCE_WORKER_KINDS=$(get_env_value MAINTENANCE_WORKER_KINDS)" \
		-e "NOTIFICATION_DELIVERY_KINDS=$(get_env_value NOTIFICATION_DELIVERY_KINDS)" \
		-e "CORE_NOTIFICATION_DELIVERY_READINESS_KINDS=$(reporting_expected_core_notification_delivery_kinds)" \
		api node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const {
	INTEGRATION_KINDS,
	MAINTENANCE_KINDS,
	NOTIFICATION_DELIVERY_KINDS,
	MESSAGING_QUEUE_NAMES,
	getMessagingQueueHealthExpectations
} = require('./dist/src/messaging/messaging.constants.js');

class ReadinessError extends Error {}

const requiredServices = [
	'outbox-publisher',
	'integration-worker',
	'maintenance-worker'
];

const parseEnabledKinds = (name, supportedKinds) => {
	const value = process.env[name] || '';
	const kinds = value
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
	const invalid = kinds.filter(kind => !supportedKinds.includes(kind));
	if (!kinds.length || invalid.length) {
		throw new ReadinessError(
			invalid.length
				? `${name} has unsupported values: ${invalid.join(', ')}`
				: `${name} is empty`
		);
	}
	return [...new Set(kinds)];
};

const run = async () => {
	const mode = (process.env.MODE || 'production').trim().toLowerCase();
	const databaseUrl =
		mode === 'production'
			? process.env.DATABASE_URL_PRODUCTION
			: process.env.DATABASE_URL_DEVELOPMENT;
	if (!databaseUrl) {
		throw new ReadinessError('Messaging readiness database URL is missing');
	}

	const startedAt = Date.parse(
		process.env.MESSAGING_READINESS_STARTED_AT || ''
	);
	if (!Number.isFinite(startedAt)) {
		throw new ReadinessError('Messaging readiness timestamp is invalid');
	}
	const requiredKinds = [
		...parseEnabledKinds('INTEGRATION_WORKER_KINDS', INTEGRATION_KINDS),
		...parseEnabledKinds('MAINTENANCE_WORKER_KINDS', MAINTENANCE_KINDS),
		...parseEnabledKinds(
			'CORE_NOTIFICATION_DELIVERY_READINESS_KINDS',
			NOTIFICATION_DELIVERY_KINDS
		)
	];
	const requiredMainQueues = new Set(requiredKinds.map(kind => {
		const queue = MESSAGING_QUEUE_NAMES[kind];
		if (!queue) {
			throw new ReadinessError(`RabbitMQ queue is unknown for ${kind}`);
		}
		return queue;
	}));
	const requiredQueues = getMessagingQueueHealthExpectations({
		billingOwner: process.env.BILLING_OWNER_ACTIVE === 'true'
	}).filter(expectation => {
		const base = expectation.name.endsWith('.dead-letter')
			? expectation.name.slice(0, -'.dead-letter'.length)
			: expectation.name;
		return requiredMainQueues.has(base);
	});
	requiredQueues.push(
		{
			name: 'winwidget.notification.telegram-destination-unavailable',
			consumerExpectation: 'at-least-one',
			alertOnAnyMessage: false
		},
		...['.dead-letter', '.retry-v2.1', '.retry-v2.2', '.retry-v2.3'].map(
			suffix => ({
				name: `winwidget.notification.telegram-destination-unavailable${suffix}`,
				consumerExpectation: 'none',
				alertOnAnyMessage: true
			})
		)
	);
	const freshAfter = new Date(Math.max(startedAt, Date.now() - 30_000));
	const prisma = new PrismaClient({
		datasources: { db: { url: databaseUrl } }
	});

	try {
		const heartbeats = await prisma.messagingHeartbeat.findMany({
			where: {
				service: { in: requiredServices },
				lastSeenAt: { gte: freshAfter }
			},
			select: { service: true }
		});
		const activeServices = new Set(heartbeats.map(item => item.service));
		const missingServices = requiredServices.filter(
			service => !activeServices.has(service)
		);
		if (missingServices.length) {
			throw new ReadinessError(
				`Missing fresh heartbeat: ${missingServices.join(', ')}`
			);
		}

		const baseUrl = (
			process.env.RABBITMQ_MANAGEMENT_URL || 'http://127.0.0.1:15672'
		).replace(/\/$/, '');
		const user = process.env.RABBITMQ_MONITOR_USER;
		const password = process.env.RABBITMQ_MONITOR_PASSWORD;
		const vhost = process.env.RABBITMQ_VHOST || 'winwidget';
		if (!user || !password) {
			throw new ReadinessError(
				'RabbitMQ management credentials are missing'
			);
		}
			const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString(
				'base64'
			)}`;
			const nodesResponse = await fetch(`${baseUrl}/api/nodes`, {
				headers: { Authorization: authorization },
				signal: AbortSignal.timeout(4000)
			});
			if (!nodesResponse.ok) {
				await nodesResponse.body?.cancel();
				throw new ReadinessError(
					`RabbitMQ nodes returned HTTP ${nodesResponse.status}`
				);
			}
			const nodes = await nodesResponse.json();
			if (
				!Array.isArray(nodes) ||
				!nodes.length ||
				nodes.some(
					node =>
						node.running === false ||
						node.mem_alarm === true ||
						node.disk_free_alarm === true ||
						(Array.isArray(node.partitions) &&
							node.partitions.length > 0)
				)
			) {
				throw new ReadinessError(
					'RabbitMQ node is stopped or reports an alarm/partition'
				);
			}

			for (const expectation of requiredQueues) {
			const queue = expectation.name;
			let response;
			try {
				response = await fetch(
					`${baseUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`,
					{
						headers: { Authorization: authorization },
						signal: AbortSignal.timeout(4000)
					}
				);
			} catch {
				throw new ReadinessError(
					`RabbitMQ queue check failed: ${queue}`
				);
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new ReadinessError(
					`RabbitMQ queue ${queue} returned HTTP ${response.status}`
				);
			}
			const state = await response.json();
			const consumersMatch =
				Number.isInteger(state.consumers) &&
				(expectation.consumerExpectation === 'none'
					? state.consumers === 0
					: state.consumers >= 1);
			if (!consumersMatch) {
				throw new ReadinessError(
					`RabbitMQ queue consumer ownership drifted: ${queue}`
				);
			}
		}
	} finally {
		await prisma.$disconnect();
	}
};

run()
	.then(() => {
		process.stdout.write(
			'Messaging heartbeats and RabbitMQ consumers are ready\n'
		);
	})
	.catch(error => {
		const message =
			error instanceof ReadinessError
				? error.message
				: 'Messaging readiness could not query PostgreSQL or RabbitMQ';
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
NODE
}

ensure_required_services_running

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend revision healthcheck failed: $HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

if ! verify_active_reporting_runtime \
	"$reporting_runtime_container_before" \
	"$reporting_runtime_image_before"; then
	echo "Reporting runtime verification failed: $REPORTING_READINESS_URL"
	show_api_diagnostics
	exit 1
fi

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$PUBLIC_HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Public backend revision healthcheck failed: $PUBLIC_HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS --connect-timeout 3 --max-time 5 "$READINESS_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend readiness check failed: $READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS --connect-timeout 3 --max-time 5 "$GATEWAY_READINESS_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "API Gateway readiness check failed: $GATEWAY_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$MAINTENANCE_READINESS_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Maintenance readiness check failed: $MAINTENANCE_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

if ! wait_for_database_restore_worker; then
	show_api_diagnostics
	exit 1
fi

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$NOTIFICATION_DELIVERY_READINESS_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Notification delivery readiness check failed: $NOTIFICATION_DELIVERY_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$CAMPAIGNS_READINESS_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Campaigns readiness check failed: $CAMPAIGNS_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$WIDGETS_READINESS_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Widgets readiness check failed: $WIDGETS_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

wait_for_cutover_revision \
	"$SUPPORT_API_READINESS_URL" "$SUPPORT_REVISION" "Support API"
wait_for_cutover_revision \
	"$SUPPORT_WORKER_READINESS_URL" "$SUPPORT_REVISION" "Support worker"
wait_for_cutover_revision \
	"$SUPPORT_OUTBOX_READINESS_URL" "$SUPPORT_REVISION" "Support Outbox publisher"

docker run --rm --network host --env-file "$ENV_FILE" \
	--entrypoint node "$WIDGETS_IMAGE" \
	dist/src/cutover-main.js verify-steady >/dev/null

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_messaging_readiness; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Messaging readiness check failed"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if verify_exact_worker_consumer_ownership true; then
		break
	fi
	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Exact RabbitMQ consumer ownership verification failed"
		show_api_diagnostics
		exit 1
	fi
	sleep "$HEALTHCHECK_INTERVAL"
done

ensure_required_services_running

for service in \
	api-gateway \
	api \
	outbox-publisher \
	integration-worker \
	maintenance-worker \
	database-restore-worker \
	notification-delivery-worker \
	campaigns-service \
	reporting-service \
	widgets-service \
	"${identity_runtime_services[@]}" \
	"${billing_runtime_services[@]}" \
	"${support_runtime_services[@]}"; do
	container_id="$(
		compose_target ps -q "$service"
	)"
	image_revision="$(
		docker inspect \
			--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$container_id"
	)"
	expected_image_revision="$APP_REVISION"
	if [[ "$service" == "maintenance-worker" ]]; then
		expected_image_revision="$MAINTENANCE_REVISION"
	fi
	if [[ "$service" == "database-restore-worker" ]]; then
		expected_image_revision="$DATABASE_RESTORE_REVISION"
	fi
	if [[ "$service" == "notification-delivery-worker" ]]; then
		expected_image_revision="$NOTIFICATION_DELIVERY_REVISION"
	fi
	if [[ "$service" == "campaigns-service" ]]; then
		expected_image_revision="$CAMPAIGNS_REVISION"
	fi
	if [[ "$service" == "reporting-service" ]]; then
		expected_image_revision="$REPORTING_REVISION"
	fi
	if [[ "$service" == "widgets-service" ]]; then
		expected_image_revision="$WIDGETS_REVISION"
	fi
	if [[ "$service" == billing-* ]]; then
		expected_image_revision="$BILLING_REVISION"
	fi
	if [[ "$service" == support-* ]]; then
		expected_image_revision="$SUPPORT_REVISION"
	fi
	if [[ "$image_revision" != "$expected_image_revision" ]]; then
		echo "$service image revision mismatch: expected $expected_image_revision, got $image_revision"
		show_api_diagnostics
		exit 1
	fi

	restart_count="$(
		docker inspect --format '{{ .RestartCount }}' "$container_id"
	)"
	if [[ "$restart_count" != "0" ]]; then
		echo "$service restarted during deployment: restartCount=$restart_count"
		show_api_diagnostics
		exit 1
	fi
done

if [[ "$mode" == 'production' ]]; then
	assert_telegram_proxy_runtime || {
		echo 'Telegram proxy runtime boundary is invalid.' >&2
		exit 1
	}
	verify_telegram_https_reverse_proxy "$telegram_api_proxy_ip" || {
		echo 'Telegram HTTPS reverse proxy post-deploy smoke failed.' >&2
		exit 1
	}
fi

if [[ "$identity_cleanup_phase" == 'complete' ]]; then
	assert_clean_core_identity_environment_boundary || {
		echo 'Completed Identity cleanup runtime credential boundary is invalid.' >&2
		exit 1
	}
fi

if [[ "$notification_forward_candidate_active" == "true" ]]; then
	# Canonical services passed the complete deployment smoke, so the saved
	# forward topology is no longer the recovery authority.
	forward_cutover_recovery_active=false
	trap - EXIT INT TERM
	notification_cutover_cleanup_complete=false
	for ((attempt = 1; attempt <= 5; attempt++)); do
		if remove_notification_cutover_services \
			"${notification_cutover_candidate_services[@]}"; then
			remaining_cutover_candidate_ids="$(
				compose_notification_cutover ps -a -q \
					"${notification_cutover_candidate_services[@]}" \
					2>/dev/null || true
			)"
			if [[ -z "$remaining_cutover_candidate_ids" ]]; then
				notification_cutover_cleanup_complete=true
				break
			fi
		fi
		if ((attempt < 5)); then
			sleep "$HEALTHCHECK_INTERVAL"
		fi
	done
	if [[ "$notification_cutover_cleanup_complete" != "true" ]]; then
		echo "Canonical topology is healthy, but saved forward containers could not be removed after five attempts." >&2
		echo "Remove only the stopped $NOTIFICATION_DELIVERY_CUTOVER_PROJECT containers before the next deployment." >&2
		exit 1
	fi
	notification_forward_candidate_active=false
	echo "Canonical topology verified; saved forward cutover containers removed."
fi

reporting_require_rabbitmq_topology
if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
	reporting_cutover_require_cleanup_runtime_revision "$APP_REVISION"
	echo 'Reporting cleanup runtime and steady-state RabbitMQ topology verified.'
else
	echo 'Reporting runtime and isolated delivery outcome topology verified.'
fi

verify_notification_database_lifecycle_unchanged \
	"the routine full deployment" \
	"$notification_database_phase_before"
verify_campaigns_database_lifecycle_unchanged
reporting_verify_database_lifecycle_unchanged
[[ "$(billing_database_current_phase)" == "$billing_database_phase" ]] || {
	echo 'Billing database lifecycle changed during routine deployment.' >&2
	exit 1
}
[[ "$(widgets_service_identity_state)" == 'active' ]] || {
	echo 'Widgets ownership marker changed during routine deployment.' >&2
	exit 1
}
if [[ "$widgets_core_cleanup_runtime_deploy" == 'true' ]]; then
	widgets_core_source_cleanup_validate_marker || exit 1
	[[ "$(widgets_core_source_cleanup_marker_value phase)" == 'applied' &&
		"$(widgets_core_source_state)" == 'absent' &&
		"$(widgets_core_source_cleanup_migration_state)" == 'applied' ]] || {
		echo 'Widgets Core source cleanup runtime passed smoke without a durable absent|applied boundary.' >&2
		exit 1
	}
	widgets_core_cleanup_stop_recovery_active=false
	trap - EXIT INT TERM
	echo 'Widgets Core source cleanup runtime is healthy; post-cleanup backup/restore evidence remains required before phase=complete.'
fi

if [[ "$billing_core_cleanup_runtime_deploy" == 'true' ]]; then
	billing_core_source_cleanup_validate_marker || exit 1
	[[ "$(billing_core_source_cleanup_marker_value phase)" == 'applied' &&
		"$(billing_core_source_state)" == 'absent' &&
		"$(billing_core_source_cleanup_migration_state)" == 'applied' ]] || {
		echo 'Billing Core cleanup runtime passed smoke without a durable absent|applied boundary.' >&2
		exit 1
	}
	billing_core_cleanup_require_retired_outcome_absent || {
		echo 'Retired Core notification outcome topology reappeared after cleanup smoke.' >&2
		exit 1
	}
	billing_core_cleanup_stop_recovery_active=false
	trap - EXIT INT TERM
	echo 'Billing Core source cleanup runtime is healthy; post-cleanup backup, restore and offsite evidence remain required before phase=complete.'
fi

if [[ "$billing_core_cleanup_marker_phase" == 'complete' ]]; then
	billing_core_source_cleanup_validate_marker &&
		billing_require_core_source_absent &&
		billing_core_source_cleanup_require_exact_migration_manifest applied || {
		echo 'Completed Billing Core cleanup invariant failed after routine smoke.' >&2
		exit 1
	}
	billing_core_cleanup_require_retired_outcome_absent || {
		echo 'Retired Core notification outcome topology reappeared after routine smoke.' >&2
		exit 1
	}
fi

if [[ "$reporting_cleanup_stop_recovery_active" == 'true' ]]; then
	reporting_cleanup_stop_recovery_active=false
	trap - EXIT INT TERM
fi

echo "Backend revision verified locally and publicly: $APP_REVISION"

compose_target ps \
	api-gateway api outbox-publisher integration-worker maintenance-worker database-restore-worker notification-delivery-worker campaigns-service reporting-service widgets-service "${identity_runtime_services[@]}" "${billing_runtime_services[@]}" rabbitmq
