import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const widgetDir = join(root, 'public/widgets');
const widgetSourceDir = join(root, 'widgets-src');

const files = [
	'wheel.js',
	'quiz.js',
	'callback.js',
	'timer.js',
	'stop-offer.js',
	'online-consultant.js',
	'calculator.js',
	'helpers/winwidget-phone.js'
];
const apiRuntimeFiles = files.filter(file => !file.startsWith('helpers/'));
const externalUrlRuntimeFiles = [
	'quiz.js',
	'callback.js',
	'timer.js',
	'stop-offer.js',
	'online-consultant.js',
	'calculator.js'
];
const contactLinkRuntimeFiles = new Set([
	'quiz.js',
	'timer.js',
	'stop-offer.js',
	'online-consultant.js'
]);

for (const file of files) {
	const fullPath = join(widgetDir, file);

	await stat(fullPath);

	const result = spawnSync(process.execPath, ['--check', fullPath], {
		stdio: 'inherit'
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}

	console.log(`widgets: checked ${file}`);
}

for (const file of apiRuntimeFiles) {
	const content = await readFile(join(widgetDir, file), 'utf8');

	if (!content.includes('/api/v1')) {
		console.error(`widgets: ${file} does not use the /api/v1 contract`);
		process.exit(1);
	}
}

const unsafeRuntimePatterns = [
	[/\bprivacy(?:El)?\.innerHTML\s*=/, 'privacy innerHTML'],
	[/\bsuccess\.innerHTML\s*=/, 'success innerHTML'],
	[/\banswer\.innerHTML\s*=/, 'answer innerHTML'],
	[/\blink\.href\s*=\s*cfg\.actionButtonUrl/, 'unvalidated action URL'],
	[/\besc\(\s*cfg\.privacyUrl\s*\)/, 'unvalidated privacy URL'],
	[/\besc\(\s*rd\.buttonUrl\s*\)/, 'unvalidated result URL']
];

const getNamedFunctionSource = (content, functionName) => {
	const start = content.indexOf(`function ${functionName}(`);
	if (start === -1) return '';

	const bodyStart = content.indexOf('{', start);
	let depth = 0;
	for (let index = bodyStart; index < content.length; index += 1) {
		if (content[index] === '{') depth += 1;
		if (content[index] === '}') depth -= 1;
		if (depth === 0) return content.slice(start, index + 1);
	}
	return '';
};

for (const file of externalUrlRuntimeFiles) {
	const content = await readFile(join(widgetSourceDir, file), 'utf8');
	const safeUrlFunctionSource = getNamedFunctionSource(
		content,
		'getSafeExternalUrl'
	);

	if (!safeUrlFunctionSource) {
		console.error(`widgets: ${file} does not validate external URLs`);
		process.exit(1);
	}

	for (const [pattern, label] of unsafeRuntimePatterns) {
		if (pattern.test(content)) {
			console.error(
				`widgets: ${file} contains an unsafe dynamic DOM sink: ${label}`
			);
			process.exit(1);
		}
	}

	const getSafeExternalUrl = new Function(
		'window',
		'URL',
		`${safeUrlFunctionSource}; return getSafeExternalUrl;`
	)({ location: { href: 'https://customer.example/current/page' } }, URL);
	const supportsContactLinks = contactLinkRuntimeFiles.has(file);
	const urlChecks = [
		['javascript:alert(1)', true, ''],
		['data:text/html,unsafe', true, ''],
		['/sale', false, 'https://customer.example/sale'],
		['https://example.com/path', false, 'https://example.com/path'],
		[
			'tel:+79991234567',
			true,
			supportsContactLinks ? 'tel:+79991234567' : ''
		],
		[
			'mailto:test@example.com',
			true,
			supportsContactLinks ? 'mailto:test@example.com' : ''
		]
	];

	for (const [value, allowContactProtocols, expected] of urlChecks) {
		const actual = getSafeExternalUrl(value, allowContactProtocols);
		if (actual !== expected) {
			console.error(
				`widgets: ${file} normalized ${value} to ${actual || '(empty)'} instead of ${expected || '(empty)'}`
			);
			process.exit(1);
		}
	}
}

const runtimeSources = Object.fromEntries(
	await Promise.all(
		apiRuntimeFiles.map(async file => [
			file,
			await readFile(join(widgetSourceDir, file), 'utf8')
		])
	)
);

const requireRuntimeSource = (file, source, label) => {
	if (runtimeSources[file].includes(source)) return;
	console.error(`widgets: ${file} is missing ${label}`);
	process.exit(1);
};

const requireOrderedRuntimeSource = (file, functionName, sources) => {
	const functionSource = getNamedFunctionSource(
		runtimeSources[file],
		functionName
	);
	let previousIndex = -1;

	for (const source of sources) {
		const index = functionSource.indexOf(source);
		if (index === -1 || index <= previousIndex) {
			console.error(
				`widgets: ${file} has an invalid ${functionName} operation order`
			);
			process.exit(1);
		}
		previousIndex = index;
	}
};

for (const [file, eventFunction, openGoal, submitGoal] of [
	['callback.js', 'firePixelEvent', 'wcb_open', 'wcb_send'],
	['timer.js', 'firePixelEvent', 'wt_open', 'wt_send'],
	['online-consultant.js', 'firePixelEvent', 'woc_open', 'woc_send'],
	['quiz.js', 'firePixel', 'wq_open', 'wq_send']
]) {
	requireRuntimeSource(file, `${eventFunction}('${openGoal}')`, openGoal);
	requireRuntimeSource(
		file,
		`${eventFunction}('${submitGoal}')`,
		submitGoal
	);
}

if (
	runtimeSources['quiz.js'].includes("firePixel('quiz_open')") ||
	runtimeSources['quiz.js'].includes("firePixel('quiz_lead')")
) {
	console.error('widgets: quiz.js uses stale analytics event names');
	process.exit(1);
}

for (const unsafeColorSource of [
	'var _accent = cfg.color',
	"'#wq-card{background:' + cfg.bgColor",
	'var _openBtnColor = cfg.openButtonColor'
]) {
	if (!runtimeSources['quiz.js'].includes(unsafeColorSource)) continue;
	console.error(
		'widgets: quiz.js interpolates an unvalidated color into dynamic CSS'
	);
	process.exit(1);
}

requireRuntimeSource(
	'quiz.js',
	"var _accent = getSafeColor(cfg.color, '#7c3aed');",
	'validated quiz accent color'
);

for (const file of ['wheel.js', 'quiz.js']) {
	const submitFunction = getNamedFunctionSource(
		runtimeSources[file],
		file === 'wheel.js' ? 'sendResultToServer' : 'submitAndShowResult'
	);
	if (!submitFunction.includes('if (!response.ok)')) {
		console.error(
			`widgets: ${file} does not check the lead response status`
		);
		process.exit(1);
	}
}

for (const [blurHandler, fieldValidator] of [
	['handleBlurInputName', 'validateName();'],
	['handleBlurInputPhone', 'validatePhone();'],
	['handleBlurInputEmail', 'validateEmail();']
]) {
	const blurHandlerSource = getNamedFunctionSource(
		runtimeSources['wheel.js'],
		blurHandler
	);

	if (
		!blurHandlerSource.includes(fieldValidator) ||
		/\bvalidate\(\);/.test(blurHandlerSource)
	) {
		console.error(
			`widgets: wheel.js ${blurHandler} must validate only its own field`
		);
		process.exit(1);
	}
}

requireOrderedRuntimeSource('wheel.js', 'swingEffect', [
	'if (!result.success)',
	'rememberPlayed()',
	"firePixelEvent('ip3_send')",
	'showElements()'
]);
requireOrderedRuntimeSource('quiz.js', 'submitAndShowResult', [
	'if (!response.ok)',
	'setPlayedCookie()',
	"firePixel('wq_send')",
	'showResult(resultData)'
]);

if (
	getNamedFunctionSource(
		runtimeSources['wheel.js'],
		'spinStartAnimate'
	).includes('localStorage.setItem')
) {
	console.error('widgets: wheel.js locks a spin before lead submission');
	process.exit(1);
}

if (
	runtimeSources['timer.js'].includes(
		"getLeftMs() <= 0 && cfg.expiredBehavior !== 'disableForm'"
	)
) {
	console.error(
		'widgets: timer.js can render the contact form after an expired timer'
	);
	process.exit(1);
}

const callbackDuplicateGate = runtimeSources['callback.js'].indexOf(
	'if (cfg.hasSubmittedByIp && cfg.filterDuplicates) return;'
);
const callbackLauncherDisplay = runtimeSources['callback.js'].indexOf(
	"cbBtn.style.display = AUTO_OPEN ? 'none' : 'flex';"
);
if (
	callbackDuplicateGate === -1 ||
	callbackLauncherDisplay === -1 ||
	callbackDuplicateGate > callbackLauncherDisplay
) {
	console.error(
		'widgets: callback.js displays the launcher before the duplicate gate'
	);
	process.exit(1);
}

requireRuntimeSource(
	'online-consultant.js',
	"button.style.display = 'none';",
	'successful-submit launcher cleanup'
);
