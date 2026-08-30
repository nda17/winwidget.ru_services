import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const widgetDir = join(appRoot, 'public/widgets');
const widgetSourceDir = join(appRoot, 'widgets-src');

const files = [
	'wheel.js',
	'quiz.js',
	'callback.js',
	'timer.js',
	'stop-offer.js',
	'ai-consultant.js',
	'calculator.js',
	'helpers/winwidget-phone.js'
];
const apiRuntimeFiles = files.filter(file => !file.startsWith('helpers/'));
const externalUrlRuntimeFiles = [
	'quiz.js',
	'callback.js',
	'timer.js',
	'stop-offer.js',
	'ai-consultant.js',
	'calculator.js'
];
const contactLinkRuntimeFiles = new Set([
	'quiz.js',
	'timer.js',
	'stop-offer.js'
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

const requireRuntimePattern = (file, pattern, label) => {
	if (pattern.test(runtimeSources[file])) return;
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

const telemetryRuntimeTypes = {
	'wheel.js': 'wheel',
	'quiz.js': 'quiz',
	'callback.js': 'callback',
	'timer.js': 'countdown-timer',
	'stop-offer.js': 'stop-offer',
	'ai-consultant.js': 'ai-consultant',
	'calculator.js': 'calculator'
};

for (const [file, runtimeType] of Object.entries(telemetryRuntimeTypes)) {
	const runtimeVersion =
		file === 'callback.js' ? '2026.08.28-callback-otp' : '2026.08';
	const telemetryFunctionSource = getNamedFunctionSource(
		runtimeSources[file],
		'sendTelemetryEvent'
	);
	if (!telemetryFunctionSource) {
		console.error(`widgets: ${file} is missing runtime telemetry`);
		process.exit(1);
	}

	const telemetryHelpers =
		file === 'ai-consultant.js'
			? [
					getNamedFunctionSource(
						runtimeSources[file],
						'isDirectPreviewPage'
					),
					getNamedFunctionSource(
						runtimeSources[file],
						'getWidgetFetchOptions'
					)
				]
			: [];
	const createTelemetry = (fetchStub, directPage = false) =>
		new Function(
			'fetch',
			'API_BASE',
			'KEY',
			'window',
			[
				`var RUNTIME_VERSION = ${JSON.stringify(runtimeVersion)};`,
				'var PUBLISHED_VERSION = 1;',
				'var telemetryEventsSent = Object.create(null);',
				...telemetryHelpers,
				telemetryFunctionSource,
				'return sendTelemetryEvent;'
			].join('\n')
		)(fetchStub, 'https://api.example/api/v1', 'public-key', {
			location: directPage
				? {
						hostname: 'winwidget.ru',
						pathname: '/page-ai-consultant/public-key'
					}
				: { hostname: 'shop.example.test', pathname: '/catalog' }
		});

	const requests = [];
	const sendTelemetryEvent = createTelemetry((url, options) => {
		requests.push({ url, options });
		return Promise.resolve();
	});
	const sendStart = () =>
		file === 'wheel.js'
			? sendTelemetryEvent('START', 'public-key')
			: sendTelemetryEvent('START');
	const sendComplete = () =>
		file === 'wheel.js'
			? sendTelemetryEvent('COMPLETE', 'public-key')
			: sendTelemetryEvent('COMPLETE');

	sendStart();
	sendStart();
	sendComplete();
	sendComplete();

	if (requests.length !== 4) {
		console.error(
			`widgets: ${file} must send each runtime event at most once`
		);
		process.exit(1);
	}

	const expectedEvents = ['IMPRESSION', 'OPEN', 'START', 'COMPLETE'];
	requests.forEach((request, index) => {
		const payload = JSON.parse(request.options.body);
		const payloadKeys = Object.keys(payload).sort();
		const expectedUrl =
			'https://api.example/api/v1/widget-events/' +
			runtimeType +
			'/public-key';

		if (
			request.url !== expectedUrl ||
			request.options.method !== 'POST' ||
			request.options.keepalive !== true ||
			request.options.credentials !== 'omit' ||
			request.options.referrerPolicy !== 'no-referrer' ||
			request.options.headers?.['Content-Type'] !== 'application/json' ||
			payload.event !== expectedEvents[index] ||
			payload.runtimeVersion !== runtimeVersion ||
			payload.publishedVersion !== 1 ||
			payloadKeys.join(',') !== 'event,publishedVersion,runtimeVersion'
		) {
			console.error(`widgets: ${file} has an invalid telemetry contract`);
			process.exit(1);
		}
	});
	if (file === 'ai-consultant.js') {
		const directRequests = [];
		const directTelemetry = createTelemetry((url, options) => {
			directRequests.push({ url, options });
			return Promise.resolve();
		}, true);
		directTelemetry('IMPRESSION');
		if (
			directRequests.length !== 1 ||
			directRequests[0].options.referrerPolicy !== 'unsafe-url'
		) {
			console.error(
				'widgets: ai-consultant.js direct telemetry must expose only its direct-page URL'
			);
			process.exit(1);
		}
	}

	const failOpenTelemetry = createTelemetry(() => {
		throw new Error('network unavailable');
	});
	try {
		if (file === 'wheel.js') {
			failOpenTelemetry('START', 'public-key');
		} else {
			failOpenTelemetry('START');
		}
	} catch {
		console.error(`widgets: ${file} telemetry is not fail-open`);
		process.exit(1);
	}

	requireRuntimeSource(
		file,
		"sendTelemetryEvent('COMPLETE'",
		'completion telemetry'
	);
}

for (const [file, eventFunction, openGoal, submitGoal] of [
	['callback.js', 'firePixelEvent', 'wcb_open', 'wcb_send'],
	['timer.js', 'firePixelEvent', 'wt_open', 'wt_send'],
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
	if (
		file === 'wheel.js' &&
		!submitFunction.includes('url: window.location.href')
	) {
		console.error(
			'widgets: wheel.js does not include the current page URL in the lead payload'
		);
		process.exit(1);
	}
}

for (const blurListener of [
	"inputName.addEventListener('blur'",
	"inputPhone.addEventListener('blur'",
	"inputEmail.addEventListener('blur'"
]) {
	if (!runtimeSources['wheel.js'].includes(blurListener)) continue;
	console.error(
		'widgets: wheel.js must animate field errors only after an explicit submit'
	);
	process.exit(1);
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

const callbackConfigValidator = getNamedFunctionSource(
	runtimeSources['callback.js'],
	'validateRuntimeConfig'
);
const validateCallbackConfig = new Function(
	`${callbackConfigValidator}; return validateRuntimeConfig;`
)();
for (const [config, valid] of [
	[{ isActive: false }, true],
	[
		{ isActive: true, verificationMode: 'OFF', launcherEnabled: true },
		true
	],
	[
		{ isActive: true, verificationMode: 'SMS', launcherEnabled: false },
		true
	],
	[
		{ isActive: true, verificationMode: 'EMAIL', launcherEnabled: true },
		true
	],
	[{ isActive: true, launcherEnabled: true }, false],
	[{ isActive: true, verificationMode: 'OFF' }, false],
	[
		{ isActive: true, verificationMode: 'LEGACY', launcherEnabled: true },
		false
	]
]) {
	let accepted = true;
	try {
		validateCallbackConfig(config);
	} catch {
		accepted = false;
	}
	if (accepted !== valid) {
		console.error(
			'widgets: callback.js does not require the new verification/launcher config contract'
		);
		process.exit(1);
	}
}

const callbackApplyConfig = getNamedFunctionSource(
	runtimeSources['callback.js'],
	'applyRuntimeConfig'
);
const callbackDuplicateGate = callbackApplyConfig.indexOf(
	'if (cfg.hasSubmittedByIp && cfg.filterDuplicates)'
);
const callbackReadyGate = callbackApplyConfig.indexOf(
	'publicApi.ready = true;'
);
if (
	callbackDuplicateGate === -1 ||
	callbackReadyGate === -1 ||
	callbackDuplicateGate > callbackReadyGate
) {
	console.error(
		'widgets: callback.js becomes ready before the duplicate gate'
	);
	process.exit(1);
}

const callbackStartVerification = getNamedFunctionSource(
	runtimeSources['callback.js'],
	'startVerification'
);
const callbackSubmitLead = getNamedFunctionSource(
	runtimeSources['callback.js'],
	'submitLead'
);
const callbackOpenModal = getNamedFunctionSource(
	runtimeSources['callback.js'],
	'openModal'
);
const callbackFireEvent = getNamedFunctionSource(
	runtimeSources['callback.js'],
	'fireEvent'
);
const callbackDestroy = getNamedFunctionSource(
	runtimeSources['callback.js'],
	'destroyWidget'
);

for (const [source, label] of [
	["'/verification/start'", 'callback verification start endpoint'],
	["verificationMode === 'SMS'", 'server-configured SMS request'],
	['? { phone: getPhone() }', 'SMS-only start payload'],
	[': { email: getEmail() };', 'email-only start payload'],
	['state.challengeId = data.challengeId;', 'challenge state'],
	['state.resendAvailableAt = resendAvailableAt;', 'resend deadline'],
	['updateResendCountdown();', 'resend countdown']
]) {
	if (callbackStartVerification.includes(source)) continue;
	console.error(`widgets: callback.js is missing ${label}`);
	process.exit(1);
}

if (/\bchannel\s*:/.test(callbackStartVerification)) {
	console.error(
		'widgets: callback.js must not let the browser choose the verification channel'
	);
	process.exit(1);
}

for (const [source, label] of [
	[
		'payload.challengeId = state.challengeId;',
		'lead challenge identifier'
	],
	['payload.code = code;', 'lead one-time code'],
	["if (verificationMode === 'EMAIL')", 'EMAIL challenge binding'],
	['payload.email = state.contact;', 'EMAIL-only verification contact'],
	['data.success !== true', 'created-lead response validation'],
	[
		"typeof data.lead.id !== 'string'",
		'created lead identifier validation'
	],
	["sendTelemetryEvent('COMPLETE');", 'post-create completion telemetry']
]) {
	if (callbackSubmitLead.includes(source)) continue;
	console.error(`widgets: callback.js is missing ${label}`);
	process.exit(1);
}

if (
	callbackSubmitLead.indexOf("if (verificationMode === 'EMAIL')") >
	callbackSubmitLead.indexOf('payload.email = state.contact;')
) {
	console.error(
		'widgets: callback.js must include email only inside the EMAIL verification branch'
	);
	process.exit(1);
}

requireOrderedRuntimeSource('callback.js', 'submitLead', [
	'data.success !== true',
	'submitted = true;',
	"sendTelemetryEvent('COMPLETE');"
]);

for (const [source, label] of [
	['pendingOpen = true;', 'queued early open'],
	['publicApi.ready !== true', 'readiness gate']
]) {
	if (callbackOpenModal.includes(source)) continue;
	console.error(`widgets: callback.js is missing ${label}`);
	process.exit(1);
}

if (
	!callbackFireEvent.includes('detail: { key: KEY }') ||
	!runtimeSources['callback.js'].includes("fireEvent('ready')")
) {
	console.error(
		'widgets: callback.js does not expose keyed ready/open/close events'
	);
	process.exit(1);
}

for (const [source, label] of [
	['key: KEY', 'public widget key'],
	['ready: false', 'public readiness flag'],
	['open: openModal', 'public open method'],
	['close: closeModal', 'public close method'],
	['refresh: refreshWidgetConfig', 'public refresh method'],
	['destroy: destroyWidget', 'public destroy method'],
	['cfg.launcherEnabled === true', 'launcherEnabled visibility gate'],
	["codeInput.autocomplete = 'one-time-code';", 'OTP autocomplete hint'],
	["codeInput.inputMode = 'numeric';", 'numeric OTP keyboard'],
	[
		'Duplicate script ignored; only one callback widget instance is supported per page.',
		'deterministic duplicate-script warning'
	],
	[
		"var RUNTIME_VERSION = '2026.08.28-callback-otp';",
		'callback OTP runtime version marker'
	],
	["response.headers.get('Retry-After')", 'Retry-After response parsing'],
	['error.retryAfterSeconds', 'OTP retry cooldown state']
]) {
	requireRuntimeSource('callback.js', source, label);
}

if (
	/getWidgetAssetUrl\('callback-button\.png'\)\s*\+\s*getWidgetAssetUrl\('callback-button\.png'\)/.test(
		runtimeSources['callback.js']
	)
) {
	console.error(
		'widgets: callback.js duplicates the launcher asset URL in img.src'
	);
	process.exit(1);
}

for (const [source, label] of [
	['clearManagedAsyncWork();', 'timer cleanup'],
	[
		"window.removeEventListener('scroll', handleWindowScroll);",
		'window listener cleanup'
	],
	['abortController(configRequestController);', 'config request cleanup'],
	['disposeFormState();', 'form request cleanup']
]) {
	if (callbackDestroy.includes(source)) continue;
	console.error(`widgets: callback.js is missing ${label}`);
	process.exit(1);
}

requireRuntimePattern(
	'ai-consultant.js',
	/['"]\/ai-consultant\/['"]\s*\+\s*encodeURIComponent\(KEY\)\s*\+\s*['"]\/session['"]/,
	'AI session endpoint'
);
requireRuntimePattern(
	'ai-consultant.js',
	/['"]\/ai-consultant\/['"]\s*\+\s*encodeURIComponent\(KEY\)\s*\+\s*['"]\/messages['"]/,
	'AI message endpoint'
);
requireRuntimePattern(
	'ai-consultant.js',
	/var AUTO_FOCUS_ENABLED\s*=\s*window\.__winwidgetPreviewDisableAutoFocus\s*!==\s*true;/,
	'preview-only autofocus opt-out'
);

const aiSendMessageSource = getNamedFunctionSource(
	runtimeSources['ai-consultant.js'],
	'sendMessage'
);
const aiOpenChatSource = getNamedFunctionSource(
	runtimeSources['ai-consultant.js'],
	'openChat'
);
if (
	!aiSendMessageSource.includes(
		'if (isOpen && !destroyed && AUTO_FOCUS_ENABLED) input.focus();'
	) ||
	!aiOpenChatSource.includes('if (AUTO_FOCUS_ENABLED) input.focus();')
) {
	console.error(
		'widgets: ai-consultant.js must not steal focus inside the settings preview'
	);
	process.exit(1);
}

for (const [source, label] of [
	["button.id = 'waic-button'", 'canonical launcher selector'],
	["overlay.id = 'waic-overlay'", 'canonical overlay selector'],
	["modal.id = 'waic-modal'", 'canonical chat selector'],
	['requestId: uuid()', 'request idempotency key'],
	['sessionId: sessionId', 'chat session identifier'],
	['sessionToken: sessionToken', 'signed chat session token'],
	['turnstileToken: turnstileToken', 'one-time Turnstile token'],
	['fetchWithRequestTimeout', 'request-only timeout phase'],
	['SESSION_REQUEST_TIMEOUT_MS = 30000', 'bounded session request phase'],
	['MESSAGE_REQUEST_TIMEOUT_MS = 55000', 'bounded two-call AI phase'],
	['TURNSTILE_CHALLENGE_TIMEOUT_MS = 120000', 'bounded challenge phase'],
	['cData: KEY', 'Turnstile widget binding'],
	[
		'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
		'exact Turnstile runtime URL'
	],
	['history: previousHistory', 'bounded in-memory history'],
	[
		"'Не указывайте персональные данные. Вопрос и контекст диалога обрабатываются Cloudflare Workers AI. '",
		'personal-data warning and provider disclosure'
	],
	[
		'getSafeExternalUrl(config.privacyUrl, false)',
		'validated public privacy policy URL'
	],
	["aiBadge.textContent = 'AI-оператор'", 'explicit AI operator badge'],
	[
		"statusText.textContent = 'Отвечает по инструкциям'",
		'neutral instruction-bound status'
	],
	["? 'Формирует ответ…'", 'neutral AI generation state'],
	["+ ' присоединился к чату'", 'operator join event'],
	["+ ' покинул чат'", 'operator leave event'],
	["+ ' печатает'", 'operator typing state']
]) {
	requireRuntimeSource('ai-consultant.js', source, label);
}

for (const forbidden of ['waic-status-dot', 'Готов ответить']) {
	if (!runtimeSources['ai-consultant.js'].includes(forbidden)) continue;
	console.error(
		`widgets: ai-consultant.js contains human-like status source ${forbidden}`
	);
	process.exit(1);
}

if (
	!runtimeSources['ai-consultant.js'].includes('currentScript.nonce') ||
	!runtimeSources['ai-consultant.js'].includes(
		'style.nonce = STYLE_NONCE'
	) ||
	!runtimeSources['ai-consultant.js'].includes(
		'dynamicStyle.nonce = STYLE_NONCE'
	) ||
	/\.style\s*(?:\.|\[)/.test(runtimeSources['ai-consultant.js'])
) {
	console.error(
		'widgets: ai-consultant.js must propagate a CSP nonce and avoid inline style attributes'
	);
	process.exit(1);
}

const assistantReplyAppends =
	runtimeSources['ai-consultant.js'].match(
		/appendMessage\('assistant', payload\.reply\.trim\(\)\)/g
	) || [];
if (assistantReplyAppends.length !== 1) {
	console.error(
		'widgets: ai-consultant.js must append exactly one assistant reply per request'
	);
	process.exit(1);
}

const ensureAiSessionSource = getNamedFunctionSource(
	runtimeSources['ai-consultant.js'],
	'ensureSessionToken'
);
const turnstileTokenSource = getNamedFunctionSource(
	runtimeSources['ai-consultant.js'],
	'getTurnstileToken'
);
const turnstileLoaderSource = getNamedFunctionSource(
	runtimeSources['ai-consultant.js'],
	'loadTurnstile'
);
if (
	ensureAiSessionSource.indexOf('getTurnstileToken(flowController)') ===
		-1 ||
	ensureAiSessionSource.indexOf('fetchWithRequestTimeout(') === -1 ||
	ensureAiSessionSource.indexOf('getTurnstileToken(flowController)') >
		ensureAiSessionSource.indexOf('fetchWithRequestTimeout(') ||
	getNamedFunctionSource(
		runtimeSources['ai-consultant.js'],
		'sendMessage'
	).includes('30000') ||
	!turnstileTokenSource.includes('TURNSTILE_CHALLENGE_TIMEOUT_MS') ||
	!turnstileTokenSource.includes(
		'window.clearTimeout(challengeTimeout)'
	) ||
	!ensureAiSessionSource.includes('SESSION_REQUEST_TIMEOUT_MS') ||
	!getNamedFunctionSource(
		runtimeSources['ai-consultant.js'],
		'requestAnswer'
	).includes('MESSAGE_REQUEST_TIMEOUT_MS')
) {
	console.error(
		'widgets: ai-consultant.js starts the request timeout before Turnstile completes'
	);
	process.exit(1);
}

if (
	!turnstileLoaderSource.includes('loader.catch') ||
	!turnstileLoaderSource.includes(
		'window.__winAiTurnstileLoader = null'
	) ||
	!turnstileLoaderSource.includes('script.parentNode.removeChild(script)')
) {
	console.error(
		'widgets: ai-consultant.js must reset a failed Turnstile loader so a later send can retry'
	);
	process.exit(1);
}

for (const forbidden of [
	'/lead',
	'instructionsPrompt',
	'CLOUDFLARE_TURNSTILE_SECRET_KEY',
	'localStorage',
	'sessionStorage',
	'indexedDB',
	'winwidgetAiConsultant',
	'winaiconsultant'
]) {
	if (!runtimeSources['ai-consultant.js'].includes(forbidden)) continue;
	console.error(
		`widgets: ai-consultant.js contains forbidden legacy or persistence source ${forbidden}`
	);
	process.exit(1);
}

const aiFetchOptions = getNamedFunctionSource(
	runtimeSources['ai-consultant.js'],
	'getWidgetFetchOptions'
);
if (
	!aiFetchOptions.includes('if (isDirectPreviewPage())') ||
	runtimeSources['ai-consultant.js'].includes(
		'if (AUTO_OPEN) result.referrerPolicy'
	)
) {
	console.error(
		'widgets: ai-consultant.js can disclose a customer page URL through unsafe referrer'
	);
	process.exit(1);
}
