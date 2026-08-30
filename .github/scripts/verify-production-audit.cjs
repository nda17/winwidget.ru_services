'use strict';

const { spawnSync } = require('node:child_process');

const app = process.argv[2];
const apps = new Set([
	'api-gateway',
	'campaigns',
	'identity',
	'notification-delivery',
	'operations',
	'platform',
	'reporting',
	'support',
	'widgets'
]);
if (!apps.has(app)) {
	console.error(
		`Unsupported production audit target: ${app || '<missing>'}`
	);
	process.exit(2);
}

const audit = spawnSync(
	process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
	['--dir', `apps/${app}`, 'audit', '--prod', '--json'],
	{
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024
	}
);

if (audit.error) {
	console.error(
		`Production audit could not start for ${app}: ${audit.error.message}`
	);
	process.exit(2);
}

let report;
try {
	report = JSON.parse(audit.stdout);
} catch {
	console.error(`Production audit did not return valid JSON for ${app}`);
	if (audit.stderr) console.error(audit.stderr.trim());
	process.exit(2);
}

if (
	!report ||
	typeof report !== 'object' ||
	Array.isArray(report) ||
	report.error ||
	!report.advisories ||
	typeof report.advisories !== 'object' ||
	Array.isArray(report.advisories)
) {
	const auditError =
		report && typeof report === 'object' && report.error
			? report.error
			: null;
	const code =
		auditError && typeof auditError === 'object' && auditError.code
			? String(auditError.code)
			: 'INVALID_REPORT';
	console.error(`Production audit failed closed for ${app}: ${code}`);
	process.exit(2);
}

const findings = Object.values(report.advisories ?? {}).map(advisory => ({
	id: advisory.github_advisory_id,
	module: advisory.module_name,
	severity: advisory.severity
}));
if (findings.length > 0) {
	for (const finding of findings) {
		console.error(
			`${app}: ${finding.severity} advisory ${finding.id} in ${finding.module}`
		);
	}
	process.exit(1);
}

console.log(`${app}: 0 production advisories`);
