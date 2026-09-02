'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join, relative, resolve, sep } = require('node:path');

const app = process.argv[2];
const apps = new Set([
	'api-gateway',
	'campaigns',
	'crm-access',
	'crm-customers',
	'crm-intake',
	'crm-sales',
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

const severityNames = ['info', 'low', 'moderate', 'high', 'critical'];
const vulnerabilityMetadata = report.metadata?.vulnerabilities;
const advisoryRecords = Object.values(report.advisories);
const isValidVulnerabilityMetadata =
	vulnerabilityMetadata &&
	typeof vulnerabilityMetadata === 'object' &&
	!Array.isArray(vulnerabilityMetadata) &&
	Object.keys(vulnerabilityMetadata).length === severityNames.length &&
	severityNames.every(
		severity =>
			Number.isSafeInteger(vulnerabilityMetadata[severity]) &&
			vulnerabilityMetadata[severity] >= 0
	);
if (
	audit.signal !== null ||
	!Array.isArray(report.muted) ||
	report.muted.length !== 0 ||
	!isValidVulnerabilityMetadata
) {
	console.error(`Production audit integrity contract failed for ${app}`);
	process.exit(2);
}
const metadataVulnerabilityCount = severityNames.reduce(
	(total, severity) => total + vulnerabilityMetadata[severity],
	0
);
const expectedAuditStatus = metadataVulnerabilityCount > 0 ? 1 : 0;
const advisoryCountsBySeverity = Object.fromEntries(
	severityNames.map(severity => [
		severity,
		advisoryRecords.filter(advisory => advisory.severity === severity)
			.length
	])
);
if (
	audit.status !== expectedAuditStatus ||
	(metadataVulnerabilityCount === 0) !== (advisoryRecords.length === 0) ||
	severityNames.some(
		severity =>
			vulnerabilityMetadata[severity] !==
			advisoryCountsBySeverity[severity]
	)
) {
	console.error(
		`Production audit status or vulnerability metadata is inconsistent for ${app}`
	);
	process.exit(2);
}

const findings = advisoryRecords.map(advisory => ({
	id: advisory.github_advisory_id,
	module: advisory.module_name,
	severity: advisory.severity,
	findings: advisory.findings
}));

const sha256 = value =>
	createHash('sha256').update(value, 'utf8').digest('hex');

const assertPlatformSanitizerBoundary = () => {
	const packageJson = JSON.parse(
		readFileSync(resolve('apps/platform/package.json'), 'utf8')
	);
	if (packageJson.dependencies?.['sanitize-html'] !== '2.17.5') {
		throw new Error(
			'Platform sanitizer version changed without closing its audit constraint'
		);
	}
	let ts;
	try {
		ts = require(resolve('apps/platform/node_modules/typescript'));
	} catch (error) {
		throw new Error(
			`Platform TypeScript AST parser is unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
	const boundaryPath = resolve(
		'apps/platform/src/content/platform-content.validation.ts'
	);
	const collectTypeScriptSources = directory =>
		readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(
					`Platform source symlink is forbidden while the sanitizer exception is active: ${relative(
						resolve('.'),
						path
					)}`
				);
			}
			if (entry.isDirectory()) return collectTypeScriptSources(path);
			return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
		});
	const productionSources = collectTypeScriptSources(
		resolve('apps/platform/src')
	)
		.filter(path => !path.endsWith('.spec.ts'))
		.sort();
	const repositoryRoot = resolve('.');
	const productionSourceManifest = productionSources
		.map(path => {
			const repositoryPath = relative(repositoryRoot, path)
				.split(sep)
				.join('/');
			return `${repositoryPath}\0${sha256(readFileSync(path, 'utf8'))}`;
		})
		.join('\n');
	if (
		sha256(productionSourceManifest) !==
		'a070ee6a1e5a1c5f3103e0f0cc2c5561cd78748e15b3a7bc599567420e5ffe23'
	) {
		throw new Error(
			'Platform production TypeScript source manifest drifted while the sanitizer exception is active'
		);
	}
	const sanitizerModuleReferences = [];
	const sanitizerImports = [];
	const sanitizerCalls = [];
	const sanitizerTypeReferences = [];
	const sanitizerIdentifierViolations = [];
	const optionsCallReferences = [];
	const optionsIdentifierViolations = [];
	let optionsDeclaration = null;
	let boundarySourceFile = null;
	for (const path of productionSources) {
		const content = readFileSync(path, 'utf8');
		const sourceFile = ts.createSourceFile(
			path,
			content,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		if (path === boundaryPath) boundarySourceFile = sourceFile;
		const visit = node => {
			if (
				ts.isStringLiteralLike(node) &&
				(node.text === 'sanitize-html' ||
					node.text.startsWith('sanitize-html/'))
			) {
				sanitizerModuleReferences.push({ path, node });
			}
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				node.moduleSpecifier.text === 'sanitize-html'
			) {
				sanitizerImports.push({ path, node });
			}
			if (ts.isIdentifier(node) && node.text === 'sanitizeHtml') {
				const parent = node.parent;
				if (ts.isImportClause(parent) && parent.name === node) {
					// The single default import is validated below.
				} else if (
					ts.isQualifiedName(parent) &&
					parent.left === node &&
					parent.right.text === 'IOptions'
				) {
					sanitizerTypeReferences.push({ path, node });
				} else if (
					ts.isCallExpression(parent) &&
					parent.expression === node
				) {
					sanitizerCalls.push({ path, node: parent });
				} else {
					sanitizerIdentifierViolations.push({ path, node });
				}
			}
			if (ts.isIdentifier(node) && node.text === 'SAFE_HTML_OPTIONS') {
				const parent = node.parent;
				if (ts.isVariableDeclaration(parent) && parent.name === node) {
					if (optionsDeclaration) {
						optionsIdentifierViolations.push({ path, node });
					} else {
						optionsDeclaration = { path, node: parent };
					}
				} else if (
					ts.isCallExpression(parent) &&
					parent.arguments[1] === node
				) {
					optionsCallReferences.push({ path, node });
				} else {
					optionsIdentifierViolations.push({ path, node });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	if (
		sanitizerModuleReferences.length !== 1 ||
		sanitizerImports.length !== 1 ||
		sanitizerImports[0].path !== boundaryPath ||
		sanitizerModuleReferences[0].path !== boundaryPath ||
		sanitizerModuleReferences[0].node.text !== 'sanitize-html' ||
		sanitizerModuleReferences[0].node.parent !==
			sanitizerImports[0].node ||
		!sanitizerImports[0].node.importClause ||
		sanitizerImports[0].node.importClause.isTypeOnly ||
		sanitizerImports[0].node.importClause.name?.text !== 'sanitizeHtml' ||
		sanitizerImports[0].node.importClause.namedBindings ||
		sanitizerCalls.length !== 2 ||
		sanitizerCalls.some(({ path }) => path !== boundaryPath) ||
		sanitizerCalls.some(
			({ node }) =>
				node.arguments.length !== 2 ||
				!ts.isIdentifier(node.arguments[1]) ||
				node.arguments[1].text !== 'SAFE_HTML_OPTIONS'
		) ||
		sanitizerTypeReferences.length !== 1 ||
		sanitizerTypeReferences[0].path !== boundaryPath ||
		sanitizerIdentifierViolations.length !== 0 ||
		optionsCallReferences.length !== 2 ||
		optionsCallReferences.some(({ path }) => path !== boundaryPath) ||
		optionsIdentifierViolations.length !== 0
	) {
		throw new Error(
			'Platform sanitizer AST import, reference or call-site boundary drifted'
		);
	}
	if (
		!boundarySourceFile ||
		!optionsDeclaration ||
		optionsDeclaration.path !== boundaryPath ||
		!optionsDeclaration.node.initializer ||
		!ts.isObjectLiteralExpression(optionsDeclaration.node.initializer) ||
		!ts.isVariableDeclarationList(optionsDeclaration.node.parent) ||
		!(optionsDeclaration.node.parent.flags & ts.NodeFlags.Const) ||
		!ts.isVariableStatement(optionsDeclaration.node.parent.parent)
	) {
		throw new Error(
			'Platform sanitizer options must remain one const object literal'
		);
	}
	const optionsStatement = optionsDeclaration.node.parent.parent;
	const optionsSource = boundarySourceFile.text.slice(
		optionsStatement.getStart(boundarySourceFile),
		optionsStatement.end
	);
	if (
		sha256(optionsSource) !==
		'926c2deee6b4834dade8411053b85e77a1431cbdd83ebf6a615cf2e5d098abf6'
	) {
		throw new Error(
			'Platform sanitizer exact allowlist/options hash drifted'
		);
	}

	const regressionPath = resolve(
		'apps/platform/src/content/platform-content.validation.spec.ts'
	);
	const regression = readFileSync(regressionPath, 'utf8');
	const regressionSourceFile = ts.createSourceFile(
		regressionPath,
		regression,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const regressionHashes = new Map([
		[
			'drops the SVG SMIL URL-list payload from GHSA-g8qq-57p8-ggw5',
			'b5ce8434f0a1aa8b69c55c6072668535c75c3d1505c41742009d80dedd73ca22'
		],
		[
			'drops the %s raw-text payload from GHSA-jxwj-j7wr-gfrw',
			'4f7396f26698e90dd8726bd5baaa3183a79cd7306a73886e2a45017fe80cb050'
		]
	]);
	const matchedRegressionTests = new Map();
	const disabledTestControls = [];
	const visitRegression = node => {
		if (
			ts.isIdentifier(node) &&
			['fdescribe', 'fit', 'xdescribe', 'xit', 'xtest'].includes(node.text)
		) {
			disabledTestControls.push(node.text);
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			['only', 'skip', 'todo'].includes(node.name.text)
		) {
			disabledTestControls.push(node.name.text);
		}
		if (
			ts.isCallExpression(node) &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0]) &&
			regressionHashes.has(node.arguments[0].text)
		) {
			const title = node.arguments[0].text;
			const matches = matchedRegressionTests.get(title) ?? [];
			matches.push(
				sha256(
					regressionSourceFile.text.slice(
						node.getStart(regressionSourceFile),
						node.end
					)
				)
			);
			matchedRegressionTests.set(title, matches);
		}
		ts.forEachChild(node, visitRegression);
	};
	visitRegression(regressionSourceFile);
	if (disabledTestControls.length > 0) {
		throw new Error(
			'Platform sanitizer regression suite contains disabled or focused tests'
		);
	}
	for (const [title, expectedHash] of regressionHashes) {
		const matches = matchedRegressionTests.get(title) ?? [];
		if (matches.length !== 1 || matches[0] !== expectedHash) {
			throw new Error(
				`Platform sanitizer exact regression test drifted: ${title}`
			);
		}
	}

	const regressionRun = spawnSync(
		process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
		[
			'--dir',
			'apps/platform',
			'exec',
			'jest',
			'src/content/platform-content.validation.spec.ts',
			'--runInBand',
			'--testNamePattern',
			'GHSA-',
			'--json'
		],
		{
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024
		}
	);
	if (regressionRun.error || regressionRun.status !== 0) {
		throw new Error(
			'Platform sanitizer focused regression execution failed'
		);
	}
	let regressionResult;
	try {
		regressionResult = JSON.parse(regressionRun.stdout);
	} catch {
		throw new Error(
			'Platform sanitizer focused regression result is not valid JSON'
		);
	}
	const advisoryAssertions = (regressionResult.testResults ?? []).flatMap(
		testResult =>
			(testResult.assertionResults ?? []).filter(assertion =>
				String(assertion.fullName ?? assertion.title ?? '').includes(
					'GHSA-'
				)
			)
	);
	if (
		regressionResult.success !== true ||
		advisoryAssertions.length !== 3 ||
		advisoryAssertions.some(assertion => assertion.status !== 'passed')
	) {
		throw new Error(
			'Platform sanitizer focused regression tests did not all execute and pass'
		);
	}
};

const isExactPlatformSanitizerFinding = finding =>
	Array.isArray(finding.findings) &&
	finding.findings.length === 1 &&
	finding.findings[0]?.version === '2.17.5' &&
	Array.isArray(finding.findings[0]?.paths) &&
	finding.findings[0].paths.length === 1 &&
	finding.findings[0].paths[0] === '. > sanitize-html@2.17.5';

const constrainedFindings = [];
const unresolvedFindings = [];
const constrainedPlatformSanitizerAdvisories = new Set([
	'GHSA-g8qq-57p8-ggw5',
	'GHSA-jxwj-j7wr-gfrw'
]);
let platformSanitizerBoundaryVerified = false;
if (app === 'platform') {
	try {
		assertPlatformSanitizerBoundary();
		platformSanitizerBoundaryVerified = true;
	} catch (error) {
		console.error(
			`Platform sanitizer audit constraint failed closed: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		process.exit(1);
	}
}
for (const finding of findings) {
	if (
		app === 'platform' &&
		constrainedPlatformSanitizerAdvisories.has(finding.id) &&
		finding.module === 'sanitize-html' &&
		finding.severity === 'moderate' &&
		isExactPlatformSanitizerFinding(finding)
	) {
		constrainedFindings.push(finding);
	} else {
		unresolvedFindings.push(finding);
	}
}

if (unresolvedFindings.length > 0) {
	for (const finding of unresolvedFindings) {
		console.error(
			`${app}: ${finding.severity} advisory ${finding.id} in ${finding.module}`
		);
	}
	process.exit(1);
}

if (constrainedFindings.length > 0) {
	console.log(
		`${app}: ${constrainedFindings.length} constrained production advisory finding(s); exact sanitizer boundary verified`
	);
} else if (platformSanitizerBoundaryVerified) {
	console.log(
		`${app}: 0 indexed production advisories; exact sanitizer boundary verified`
	);
} else {
	console.log(`${app}: 0 production advisories`);
}
