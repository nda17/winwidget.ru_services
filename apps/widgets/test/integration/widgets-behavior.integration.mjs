import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/widgets-client';
import * as XLSX from 'xlsx';
import { runWidgetsBrowserIntegration } from './widgets-browser.integration.mjs';

const databaseUrl = process.env.WIDGETS_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
	console.log(
		'SKIP Widgets behavior integration: WIDGETS_TEST_DATABASE_URL is not set'
	);
	process.exit(0);
}
if (process.env.WIDGETS_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('WIDGETS_INTEGRATION_ALLOW_MUTATION=true is required');
}
assertLocalTestDatabase(databaseUrl);

const runId = randomUUID();
const primaryOwnerId = cuidLikeId();
const quotaOwnerId = cuidLikeId();
const missingProjectionOwnerId = cuidLikeId();
const devActorId = cuidLikeId();
const internalToken = `widgets_behavior_internal_${randomBytes(24).toString('hex')}`;
const identityToken = `widgets_behavior_identity_${randomBytes(24).toString('hex')}`;
const browserCorsAllowedOrigins = ['https://shop.example.test'];
const actorTokens = new Map([
	['behavior-user', actor(primaryOwnerId, ['USER'])],
	['behavior-quota-user', actor(quotaOwnerId, ['USER'])],
	[
		'behavior-missing-projection',
		actor(missingProjectionOwnerId, ['USER'])
	],
	['behavior-dev', actor(devActorId, ['DEV'])]
]);
const owners = new Map([
	[primaryOwnerId, owner(primaryOwnerId, 'HARD')],
	[quotaOwnerId, owner(quotaOwnerId, 'HARD')]
]);
const s3Requests = [];
const s3Objects = new Map();
const cloudflareRequests = [];
const turnstileRequests = [];
const usedTurnstileTokens = new Set();
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const baselineHeartbeatIds = [];
let app;
let appPort;
let ownsTestData = false;
let mutationIndex = 0;

const identityServer = createIdentityServer();
const s3Server = createS3Server();
const cloudflareServer = createCloudflareServer();
const CASES = widgetCases();

try {
	await prisma.$connect();
	await assertCleanDatabase();
	baselineHeartbeatIds.push(
		...(
			await prisma.widgetsHeartbeat.findMany({ select: { id: true } })
		).map(item => item.id)
	);
	ownsTestData = true;
	await prepareDatabase();

	const identityPort = await listenLoopback(identityServer);
	const s3Port = await listenLoopback(s3Server);
	const cloudflarePort = await listenLoopback(cloudflareServer);
	appPort = await reservePort();
	app = spawn('node', ['dist/src/main.js'], {
		cwd: new URL('../../', import.meta.url),
		env: {
			...process.env,
			NODE_ENV: 'test',
			MODE: 'production',
			APP_REVISION: 'widgets-behavior-integration',
			WIDGETS_DATABASE_URL: databaseUrl,
			WIDGETS_PROCESS_ROLE: 'api',
			WIDGETS_LISTEN_HOST: '127.0.0.1',
			WIDGETS_PORT: String(appPort),
			WIDGETS_INTERNAL_TOKEN: internalToken,
			WIDGETS_IDENTITY_TOKEN: 'behavior-widgets-identity-token-20260828',
			WIDGETS_OPERATIONS_TOKEN:
				'behavior-widgets-operations-token-20260828',
			IDENTITY_INTERNAL_BASE_URL: `http://127.0.0.1:${identityPort}`,
			IDENTITY_WIDGETS_TOKEN: identityToken,
			IDENTITY_INTERNAL_TIMEOUT_MS: '2000',
			WIDGETS_ENTITLEMENT_MAX_STALENESS_MS: '86400000',
			CORS_ALLOWED_ORIGINS: browserCorsAllowedOrigins.join(','),
			S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
			S3_REGION: 'behavior-test-1',
			S3_FORCE_PATH_STYLE: 'true',
			S3_ACCESS_KEY_ID: 'widgets_behavior_access_key',
			S3_SECRET_ACCESS_KEY: 'widgets_behavior_secret_key',
			S3_BUCKET: 'behavior-bucket',
			S3_KEY_PREFIX: 'widgets-behavior',
			S3_PUBLIC_BASE_URL: `http://127.0.0.1:${s3Port}/behavior-bucket`,
			CLOUDFLARE_ACCOUNT_ID: 'behavior_account_123',
			CLOUDFLARE_API_TOKEN: 'behavior-cloudflare-token',
			CLOUDFLARE_AI_GATEWAY_ID: 'behavior-ai-gateway',
			CLOUDFLARE_AI_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8',
			CLOUDFLARE_AI_TIMEOUT_MS: '2000',
			CLOUDFLARE_AI_API_ORIGIN: `http://127.0.0.1:${cloudflarePort}`,
			WIDGETS_AI_SESSION_SECRET:
				'behavior-session-secret-with-at-least-32-bytes',
			WIDGETS_CALLBACK_OTP_SECRET:
				'behavior-callback-otp-secret-at-least-32-bytes',
			CLOUDFLARE_TURNSTILE_SITE_KEY: 'behavior-turnstile-site-key',
			CLOUDFLARE_TURNSTILE_SECRET_KEY: 'behavior-turnstile-secret-key',
			CLOUDFLARE_TURNSTILE_TIMEOUT_MS: '2000',
			CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN: `http://127.0.0.1:${cloudflarePort}`
		},
		stdio: 'inherit'
	});

	await waitForReady();
	await assertQuotaFailClosed();
	const widgets = await exerciseAllWidgetTypes();
	await assertLeadPaginationAndExports(widgets.wheel);
	await assertLifecycle(widgets.wheel);
	await assertRuntimeTelemetry(widgets);
	await assertAdminMonitoringAndAudit(widgets.wheel);
	await assertQuotaLimit();
	await resetParticipationForBrowser(widgets);
	const browserResults = await runWidgetsBrowserIntegration({
		appPort,
		widgets,
		corsAllowedOrigins: browserCorsAllowedOrigins
	});
	assert(
		cloudflareRequests.length >= 3 &&
			cloudflareRequests.every(
				request => request.payloadLogging === 'false' && request.noThinking
			) &&
			cloudflareRequests.some(request => request.maxTokens === 700) &&
			cloudflareRequests.some(request => request.maxTokens === 32),
		'Cloudflare AI Gateway integration contract was not exercised safely'
	);
	assertManagedWheelImageRead(widgets.wheel);
	await assertOwnerDeactivationBlocksPublic(widgets.wheel);
	const expectedLeadCount =
		7 +
		browserResults.filter(result => result.type !== 'ai-consultant')
			.length;
	await assertUsageCounters(expectedLeadCount);
	await deleteAllWidgets(widgets, expectedLeadCount);
	console.log(
		'Widgets full API/behavior integration passed for all seven types'
	);
} finally {
	const cleanupErrors = [];
	await captureCleanupError(cleanupErrors, () => stopChild(app));
	if (ownsTestData) {
		await captureCleanupError(cleanupErrors, () => cleanupDatabase());
	}
	await captureCleanupError(cleanupErrors, () => prisma.$disconnect());
	await captureCleanupError(cleanupErrors, () =>
		closeServer(identityServer)
	);
	await captureCleanupError(cleanupErrors, () => closeServer(s3Server));
	await captureCleanupError(cleanupErrors, () =>
		closeServer(cloudflareServer)
	);
	if (cleanupErrors.length) {
		throw new Error(
			`Widgets behavior cleanup failed: ${cleanupErrors.join('; ')}`
		);
	}
}

function widgetCases() {
	return [
		{
			key: 'wheel',
			type: 'wheel',
			collection: 'widgets',
			responseCollection: 'widgets',
			publicApi: 'widget',
			config: { title: 'Behavior wheel', filterDuplicates: false },
			lead: {
				phone: '+79990000001',
				bonus: '10%',
				url: 'https://shop.example.test/wheel'
			}
		},
		{
			key: 'quiz',
			type: 'quiz',
			collection: 'quizzes',
			responseCollection: 'quizzes',
			publicApi: 'quiz',
			config: { title: 'Behavior quiz', filterDuplicates: false },
			lead: {
				phone: '+79990000002',
				answers: [1, 2, 3, 4].map(index => ({
					questionId: `q${index}`,
					optionIds: [`q${index}o1`]
				})),
				url: 'https://shop.example.test/quiz'
			}
		},
		{
			key: 'callback',
			type: 'callback',
			collection: 'callbacks',
			responseCollection: 'callbacks',
			publicApi: 'callback',
			config: {
				title: 'Behavior callback',
				filterDuplicates: false,
				verificationMode: 'OFF',
				launcherEnabled: true
			},
			lead: {
				phone: '+79990000003',
				timeSlot: '9:00–11:00',
				timezone: 'Europe/Moscow',
				url: 'https://shop.example.test/callback'
			}
		},
		{
			key: 'timer',
			type: 'timer',
			collection: 'countdown-timers',
			responseCollection: 'countdownTimers',
			publicApi: 'countdown-timer',
			config: { title: 'Behavior timer' },
			lead: {
				phone: '+79990000004',
				url: 'https://shop.example.test/timer'
			}
		},
		{
			key: 'stopOffer',
			type: 'stop-offer',
			collection: 'stop-offers',
			responseCollection: 'stopOffers',
			publicApi: 'stop-offer',
			config: { title: 'Behavior stop offer', filterDuplicates: false },
			lead: {
				phone: '+79990000005',
				url: 'https://shop.example.test/stop-offer'
			}
		},
		{
			key: 'aiConsultant',
			type: 'ai-consultant',
			collection: 'ai-consultants',
			responseCollection: 'aiConsultants',
			publicApi: 'ai-consultant',
			config: {
				operatorName: 'Alex',
				instructionsPrompt: 'Товар Behavior стоит 1000 рублей.',
				inactivityTimeoutMinutes: 10,
				privacyUrl: 'https://shop.example.test/privacy'
			}
		},
		{
			key: 'calculator',
			type: 'calculator',
			collection: 'calculators',
			responseCollection: 'calculators',
			publicApi: 'calculator',
			config: {
				title: 'Behavior calculator',
				dataType: 'PHONE',
				filterDuplicates: false
			},
			lead: {
				phone: '+79990000007',
				answers: [
					{ fieldId: 'service', value: 'standard' },
					{ fieldId: 'quantity', value: 2 },
					{ fieldId: 'extras', value: ['delivery'] }
				],
				url: 'https://shop.example.test/calculator'
			}
		}
	];
}

async function exerciseAllWidgetTypes() {
	const created = {};
	for (const definition of CASES) {
		const emptyList = await jsonRequest(
			`/api/v1/${definition.collection}`,
			{
				token: 'behavior-user'
			}
		);
		assert(
			Array.isArray(emptyList[definition.responseCollection]),
			`${definition.type} list shape drifted`
		);
		assert(
			emptyList.subscription?.plan === 'HARD',
			`${definition.type} subscription projection drifted`
		);

		const entity = await jsonRequest(`/api/v1/${definition.collection}`, {
			method: 'POST',
			token: 'behavior-user',
			expectedStatus: 201,
			body: { name: `Behavior ${definition.type}` },
			correlationId: nextCorrelation('create')
		});
		assert(
			typeof entity.id === 'string' &&
				/^[a-f0-9]{12}$/.test(entity.publicKey),
			`${definition.type} create shape drifted`
		);
		assert(
			entity.draftRevision === 1,
			`${definition.type} initial draft revision drifted`
		);

		const listed = await jsonRequest(`/api/v1/${definition.collection}`, {
			token: 'behavior-user'
		});
		assert(
			listed[definition.responseCollection].some(
				item => item.id === entity.id
			),
			`${definition.type} is missing from authenticated list`
		);

		const updated = await jsonRequest(
			`/api/v1/${definition.collection}/${entity.id}`,
			{
				method: 'PATCH',
				token: 'behavior-user',
				body: {
					expectedDraftRevision: entity.draftRevision,
					name: `Behavior updated ${definition.type}`,
					installDomain:
						definition.key === 'aiConsultant' ? '' : 'shop.example.test',
					config: definition.config
				},
				correlationId: nextCorrelation('update')
			}
		);
		assert(
			updated.installDomain ===
				(definition.key === 'aiConsultant' ? '' : 'example.test'),
			`${definition.type} install-domain normalization drifted`
		);
		assert(
			updated.draftRevision === 2,
			`${definition.type} update did not advance the draft revision`
		);
		created[definition.key] = { ...definition, ...updated };
	}

	await assertUploadLimits(created.wheel);
	await assertAdminUploadLimit(created.wheel);
	created.wheel = await uploadWheelImage(created.wheel);
	created.aiConsultant = await publish(created.aiConsultant);
	const directAiHeaders = {
		origin: 'http://localhost:3000',
		referer: `http://localhost:3000/page-ai-consultant/${created.aiConsultant.publicKey}`
	};
	const directAiConfig = await jsonRequest(
		`/api/v1/ai-consultant/${created.aiConsultant.publicKey}/config`,
		{ headers: directAiHeaders }
	);
	assert(
		directAiConfig.isActive === true &&
			directAiConfig.turnstileSiteKey === 'behavior-turnstile-site-key' &&
			!Object.hasOwn(directAiConfig, 'instructionsPrompt'),
		'Direct-only AI consultant config drifted'
	);
	assertAiConsentConfig(directAiConfig.consent, directAiConfig.privacyUrl);
	const directSessionId = randomUUID();
	const directAcceptanceId = randomUUID();
	const directAiConsent = await jsonRequest(
		`/api/v1/ai-consultant/${created.aiConsultant.publicKey}/consents`,
		{
			method: 'POST',
			expectedStatus: 201,
			headers: directAiHeaders,
			body: {
				acceptanceId: directAcceptanceId,
				sessionId: directSessionId,
				accepted: true,
				documentVersion: directAiConfig.consent.documentVersion,
				documentHash: directAiConfig.consent.documentHash
			}
		}
	);
	assertAiConsentResponse(
		directAiConsent,
		directAcceptanceId,
		'Direct-only AI consultant'
	);
	const directAiSession = await jsonRequest(
		`/api/v1/ai-consultant/${created.aiConsultant.publicKey}/session`,
		{
			method: 'POST',
			headers: directAiHeaders,
			body: {
				sessionId: directSessionId,
				turnstileToken: `turnstile-direct-${created.aiConsultant.publicKey}`,
				consentToken: directAiConsent.consentToken
			}
		}
	);
	assert(
		directAiSession.sessionId === directSessionId &&
			typeof directAiSession.sessionToken === 'string',
		'Direct-only AI consultant session bootstrap drifted'
	);
	const externalAiDraft = await jsonRequest(
		`/api/v1/ai-consultants/${created.aiConsultant.id}`,
		{
			method: 'PATCH',
			token: 'behavior-user',
			body: {
				expectedDraftRevision: created.aiConsultant.draftRevision,
				installDomain: 'shop.example.test'
			},
			correlationId: nextCorrelation('ai-external-domain')
		}
	);
	created.aiConsultant = {
		...created.aiConsultant,
		...externalAiDraft
	};

	let publishedAiConsentConfig = null;
	for (const definition of CASES) {
		let widget = created[definition.key];
		widget = await publish(widget);
		created[definition.key] = widget;
		const config = await publicConfig(widget);
		assert(
			config.isActive === true,
			`${definition.type} public config is not active`
		);
		assert(
			config.publishedVersion === widget.publishedVersion,
			`${definition.type} public version drifted`
		);
		if (definition.key === 'wheel') {
			assert(
				config.buttonImageUrl === widget.config.buttonImageUrl,
				'Published wheel config lost its managed button image'
			);
		}
		if (definition.key === 'callback') {
			assert(
				config.verificationMode === 'OFF' &&
					config.launcherEnabled === true,
				'Callback public verification contract drifted'
			);
		}
		if (definition.key === 'aiConsultant') {
			publishedAiConsentConfig = config.consent;
			assert(
				!Object.hasOwn(config, 'instructionsPrompt'),
				'AI consultant public config exposed instructionsPrompt'
			);
			assert(
				config.turnstileSiteKey === 'behavior-turnstile-site-key' &&
					config.turnstileAction === 'ai-consultant-session',
				'AI consultant public Turnstile bootstrap config drifted'
			);
			assertAiConsentConfig(config.consent, config.privacyUrl);
		}
	}

	const beforeNone = await usage(primaryOwnerId);
	const outboxBeforeNone = await prisma.widgetsOutboxEvent.count();
	await jsonRequest(
		`/api/v1/countdown-timer/${created.timer.publicKey}/lead`,
		{
			method: 'POST',
			expectedStatus: 400,
			body: created.timer.lead,
			publicRequest: true,
			correlationId: nextCorrelation('none')
		}
	);
	const afterNone = await usage(primaryOwnerId);
	assert(
		afterNone.leadCount === beforeNone.leadCount,
		'NONE submission changed the lead counter'
	);
	assert(
		(await prisma.countdownTimerLead.count({
			where: { countdownTimerId: created.timer.id }
		})) === 0 &&
			(await prisma.widgetsOutboxEvent.count()) === outboxBeforeNone,
		'NONE submission persisted a lead or an Outbox side effect'
	);

	const timerDraft = await jsonRequest(
		`/api/v1/countdown-timers/${created.timer.id}`,
		{
			method: 'PATCH',
			token: 'behavior-user',
			body: {
				expectedDraftRevision: created.timer.draftRevision,
				config: { dataType: 'PHONE', filterDuplicates: false }
			},
			correlationId: nextCorrelation('timer-contact')
		}
	);
	created.timer = await publish({ ...created.timer, ...timerDraft });

	for (const definition of CASES.filter(
		item => item.key !== 'aiConsultant'
	)) {
		const widget = created[definition.key];
		const submitted = await jsonRequest(
			`/api/v1/${definition.publicApi}/${widget.publicKey}/lead`,
			{
				method: 'POST',
				expectedStatus: 201,
				body: definition.lead,
				publicRequest: true,
				correlationId: nextCorrelation('lead')
			}
		);
		assert(
			submitted.success === true && typeof submitted.lead?.id === 'string',
			`${definition.type} lead response drifted`
		);
	}

	const aiWidget = created.aiConsultant;
	await jsonRequest(`/api/v1/ai-consultant/${aiWidget.publicKey}/lead`, {
		method: 'POST',
		expectedStatus: 404,
		body: {},
		publicRequest: true
	});
	await jsonRequest(`/api/v1/ai-consultants/${aiWidget.id}/leads`, {
		token: 'behavior-user',
		expectedStatus: 404
	});
	await jsonRequest(
		`/api/v1/ai-consultants/${aiWidget.id}/leads/export?format=csv`,
		{
			token: 'behavior-user',
			expectedStatus: 404
		}
	);
	const publicAiRequest = {
		requestId: randomUUID(),
		sessionId: randomUUID(),
		message: 'Сколько стоит товар?',
		history: []
	};
	const publicAiAcceptanceId = randomUUID();
	const publicAiConsent = await jsonRequest(
		`/api/v1/ai-consultant/${aiWidget.publicKey}/consents`,
		{
			method: 'POST',
			expectedStatus: 201,
			body: {
				acceptanceId: publicAiAcceptanceId,
				sessionId: publicAiRequest.sessionId,
				accepted: true,
				documentVersion: publishedAiConsentConfig.documentVersion,
				documentHash: publishedAiConsentConfig.documentHash
			},
			publicRequest: true
		}
	);
	assertAiConsentResponse(
		publicAiConsent,
		publicAiAcceptanceId,
		'AI consultant public'
	);
	const forgedPreviewHeaders = {
		origin: 'https://other.example.test',
		referer: `https://winwidget.ru/page-ai-consultant/${aiWidget.publicKey}`
	};
	const forgedConfig = await jsonRequest(
		`/api/v1/ai-consultant/${aiWidget.publicKey}/config`,
		{ headers: forgedPreviewHeaders }
	);
	assert(
		forgedConfig.isActive === false &&
			!Object.hasOwn(forgedConfig, 'turnstileSiteKey'),
		'Forged platform Referer bypassed AI config hostname isolation'
	);
	const consentReceiptsBeforeForgedRequest =
		await prisma.aiConsentReceipt.count();
	await jsonRequest(
		`/api/v1/ai-consultant/${aiWidget.publicKey}/consents`,
		{
			method: 'POST',
			expectedStatus: 403,
			headers: forgedPreviewHeaders,
			body: {
				acceptanceId: randomUUID(),
				sessionId: publicAiRequest.sessionId,
				accepted: true,
				documentVersion: publishedAiConsentConfig.documentVersion,
				documentHash: publishedAiConsentConfig.documentHash
			}
		}
	);
	assert(
		(await prisma.aiConsentReceipt.count()) ===
			consentReceiptsBeforeForgedRequest,
		'Forged platform Referer persisted an AI consent receipt'
	);
	await jsonRequest(
		`/api/v1/ai-consultant/${aiWidget.publicKey}/session`,
		{
			method: 'POST',
			expectedStatus: 403,
			headers: forgedPreviewHeaders,
			body: {
				sessionId: publicAiRequest.sessionId,
				turnstileToken: `forged-${aiWidget.publicKey}`,
				consentToken: publicAiConsent.consentToken
			}
		}
	);
	assert(
		!usedTurnstileTokens.has(`forged-${aiWidget.publicKey}`),
		'Forged platform Referer reached Turnstile validation'
	);
	for (const path of [
		`/api/v1/ai-consultant/${aiWidget.publicKey}/consents`,
		`/api/v1/ai-consultant/${aiWidget.publicKey}/session`,
		`/api/v1/ai-consultant/${aiWidget.publicKey}/messages`
	]) {
		const preflight = await fetch(url(path), {
			method: 'OPTIONS',
			headers: {
				origin: 'https://shop.example.test',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type'
			}
		});
		assert(
			preflight.status === 204 &&
				preflight.headers.get('access-control-allow-origin') === '*' &&
				preflight.headers
					.get('access-control-allow-methods')
					?.includes('POST') &&
				preflight.headers
					.get('access-control-allow-headers')
					?.toLowerCase()
					.includes('content-type'),
			`AI consultant CORS preflight drifted for ${path}`
		);
	}
	const publicAiSession = await jsonRequest(
		`/api/v1/ai-consultant/${aiWidget.publicKey}/session`,
		{
			method: 'POST',
			body: {
				sessionId: publicAiRequest.sessionId,
				turnstileToken: `turnstile-${aiWidget.publicKey}`,
				consentToken: publicAiConsent.consentToken
			},
			publicRequest: true
		}
	);
	assert(
		publicAiSession.sessionId === publicAiRequest.sessionId &&
			typeof publicAiSession.sessionToken === 'string' &&
			publicAiSession.sessionToken.length >= 80,
		'AI consultant signed session response drifted'
	);
	const publicAiResponse = await jsonRequest(
		`/api/v1/ai-consultant/${aiWidget.publicKey}/messages`,
		{
			method: 'POST',
			body: {
				...publicAiRequest,
				sessionToken: publicAiSession.sessionToken
			},
			publicRequest: true
		}
	);
	assert(
		publicAiResponse.requestId === publicAiRequest.requestId &&
			publicAiResponse.outcome === 'ANSWER' &&
			typeof publicAiResponse.reply === 'string',
		'AI consultant public message response drifted'
	);
	const testAiResponse = await jsonRequest(
		`/api/v1/ai-consultants/${aiWidget.id}/test-message`,
		{
			method: 'POST',
			token: 'behavior-dev',
			body: {
				requestId: randomUUID(),
				sessionId: randomUUID(),
				message: 'Тест draft',
				history: []
			}
		}
	);
	assert(
		testAiResponse.outcome === 'ANSWER',
		'AI consultant authenticated test response drifted'
	);

	const secondWheel = await jsonRequest(
		`/api/v1/widget/${created.wheel.publicKey}/lead`,
		{
			method: 'POST',
			expectedStatus: 201,
			publicRequest: true,
			body: {
				phone: '+79990000008',
				bonus: '20%',
				url: 'https://shop.example.test/wheel-2'
			},
			headers: { 'x-forwarded-for': '127.0.0.2' },
			correlationId: nextCorrelation('lead-page')
		}
	);
	assert(
		secondWheel.success === true,
		'Second wheel lead was not accepted'
	);
	return created;
}

async function uploadWheelImage(widget) {
	const form = new FormData();
	form.set('expectedDraftRevision', String(widget.draftRevision));
	form.set(
		'file',
		new Blob([transparentPng()], { type: 'image/png' }),
		'button.png'
	);
	const response = await fetch(
		url(`/api/v1/widgets/${widget.id}/button-image`),
		{
			method: 'POST',
			headers: authenticatedHeaders(
				'behavior-user',
				nextCorrelation('image')
			),
			body: form
		}
	);
	const payload = await parseResponse(response);
	assertStatus(response, 200, 'wheel image upload', payload);
	assert(
		payload.draftRevision === widget.draftRevision + 1,
		'Image upload did not advance draft revision'
	);
	assert(
		typeof payload.config?.buttonImageUrl === 'string' &&
			payload.config.buttonImageUrl.includes(
				`/widget-buttons/wheel/${widget.id}/`
			),
		'Image upload did not return a managed URL'
	);
	const managedImagePath = new URL(payload.config.buttonImageUrl).pathname;
	assert(
		s3Requests.some(
			item =>
				item.method === 'PUT' &&
				item.path === managedImagePath &&
				item.bytes === transparentPng().length
		),
		'Fake S3 did not receive the exact managed PNG path'
	);
	return { ...widget, ...payload };
}

async function assertUploadLimits(widget) {
	const before = s3Requests.length;
	const nested = new FormData();
	nested.set(
		'expectedDraftRevision[nested]',
		String(widget.draftRevision)
	);
	nested.set(
		'file',
		new Blob([transparentPng()], { type: 'image/png' }),
		'button.png'
	);
	const nestedResponse = await fetch(
		url(`/api/v1/widgets/${widget.id}/button-image`),
		{
			method: 'POST',
			headers: authenticatedHeaders(
				'behavior-user',
				nextCorrelation('image-nested-field')
			),
			body: nested,
			signal: AbortSignal.timeout(10_000)
		}
	);
	const nestedPayload = await parseResponse(nestedResponse);
	assertStatus(
		nestedResponse,
		400,
		'wheel image nested multipart field',
		nestedPayload
	);

	const tooManyFields = new FormData();
	tooManyFields.set('expectedDraftRevision', String(widget.draftRevision));
	tooManyFields.set('unexpected', 'blocked');
	const fieldsResponse = await fetch(
		url(`/api/v1/widgets/${widget.id}/button-image`),
		{
			method: 'POST',
			headers: authenticatedHeaders(
				'behavior-user',
				nextCorrelation('image-fields-limit')
			),
			body: tooManyFields,
			signal: AbortSignal.timeout(10_000)
		}
	);
	const fieldsPayload = await parseResponse(fieldsResponse);
	assertStatus(
		fieldsResponse,
		400,
		'wheel image multipart fields limit',
		fieldsPayload
	);

	const oversized = new FormData();
	oversized.set('expectedDraftRevision', String(widget.draftRevision));
	oversized.set(
		'file',
		new Blob([Buffer.alloc(200 * 1024 + 1)], { type: 'image/png' }),
		'button.png'
	);
	const oversizedResponse = await fetch(
		url(`/api/v1/widgets/${widget.id}/button-image`),
		{
			method: 'POST',
			headers: authenticatedHeaders(
				'behavior-user',
				nextCorrelation('image-file-size-limit')
			),
			body: oversized,
			signal: AbortSignal.timeout(10_000)
		}
	);
	const oversizedPayload = await parseResponse(oversizedResponse);
	assertStatus(
		oversizedResponse,
		413,
		'wheel image multipart file-size limit',
		oversizedPayload
	);
	assert(
		s3Requests.length === before,
		'Rejected multipart uploads reached object storage'
	);
}

async function assertAdminUploadLimit(widget) {
	const before = s3Requests.length;
	const nested = new FormData();
	nested.set(
		'expectedDraftRevision[nested]',
		String(widget.draftRevision)
	);
	nested.set(
		'file',
		new Blob([transparentPng()], { type: 'image/png' }),
		'button.png'
	);
	const response = await fetch(
		url(`/api/v1/widgets/admin/wheel/${widget.id}/button-image`),
		{
			method: 'POST',
			headers: authenticatedHeaders(
				'behavior-dev',
				nextCorrelation('admin-image-nested-field')
			),
			body: nested,
			signal: AbortSignal.timeout(10_000)
		}
	);
	const payload = await parseResponse(response);
	assertStatus(
		response,
		400,
		'admin image nested multipart field',
		payload
	);
	assert(
		s3Requests.length === before,
		'Rejected admin multipart upload reached object storage'
	);
}

function assertManagedWheelImageRead(widget) {
	const imageUrl = widget.config?.buttonImageUrl;
	assert(
		typeof imageUrl === 'string' && imageUrl,
		'Managed wheel image URL is missing before browser verification'
	);
	const imagePath = new URL(imageUrl).pathname;
	assert(
		s3Requests.some(
			item =>
				item.method === 'GET' &&
				item.path === imagePath &&
				item.bytes === transparentPng().length &&
				item.contentType === 'image/png'
		),
		'Browser runtime did not read the exact managed wheel image from fake S3'
	);
}

async function publish(widget) {
	const state = await jsonRequest(
		`/api/v1/widget-settings/${widget.type}/${widget.id}/publish`,
		{
			method: 'POST',
			token: 'behavior-user',
			body: { expectedDraftRevision: widget.draftRevision },
			correlationId: nextCorrelation('publish')
		}
	);
	assert(
		state.status === 'PUBLISHED' && state.publishedVersion >= 1,
		`${widget.type} publish state drifted`
	);
	return { ...widget, ...state };
}

async function resetParticipationForBrowser(widgets) {
	for (const fixture of [
		{
			widget: widgets.wheel,
			tokenKey: 'spinResetToken',
			participationKey: 'hasPlayedByIp'
		},
		{
			widget: widgets.quiz,
			tokenKey: 'quizResetToken',
			participationKey: 'hasPlayedByIp'
		},
		{
			widget: widgets.stopOffer,
			tokenKey: 'submissionResetToken',
			participationKey: 'hasSubmittedByIp'
		}
	]) {
		const updated = await jsonRequest(
			`/api/v1/${fixture.widget.collection}/${fixture.widget.id}`,
			{
				method: 'PATCH',
				token: 'behavior-user',
				body: {
					expectedDraftRevision: fixture.widget.draftRevision,
					config: {
						[fixture.tokenKey]: `browser-${randomUUID()}`
					}
				},
				correlationId: nextCorrelation('browser-reset')
			}
		);
		Object.assign(
			fixture.widget,
			await publish({ ...fixture.widget, ...updated })
		);
		const config = await publicConfig(fixture.widget);
		assert(
			config[fixture.participationKey] === false,
			`${fixture.widget.type} browser fixture is not in a fresh participation cycle`
		);
	}
}

async function publicConfig(widget) {
	return jsonRequest(
		`/api/v1/${widget.publicApi}/${widget.publicKey}/config`,
		{ publicRequest: true }
	);
}

async function assertLeadPaginationAndExports(wheel) {
	const first = await jsonRequest(
		`/api/v1/widgets/${wheel.id}/leads?page=1&limit=1`,
		{ token: 'behavior-user' }
	);
	const second = await jsonRequest(
		`/api/v1/widgets/${wheel.id}/leads?page=2&limit=1`,
		{ token: 'behavior-user' }
	);
	assert(
		first.page === 1 &&
			first.limit === 1 &&
			first.total === 2 &&
			first.totalPages === 2,
		'Lead pagination metadata drifted'
	);
	assert(
		first.leads.length === 1 &&
			second.leads.length === 1 &&
			first.leads[0].id !== second.leads[0].id,
		'Lead pagination is not server-side'
	);

	const stats = await jsonRequest(
		`/api/v1/widgets/${wheel.id}/leads/stats`,
		{ token: 'behavior-user' }
	);
	assert(stats.total === 2, 'Wheel lead statistics drifted');

	const csv = await rawRequest(
		`/api/v1/widgets/${wheel.id}/leads/export?format=csv`,
		'behavior-user'
	);
	assert(
		csv.response.headers.get('content-type')?.startsWith('text/csv'),
		'CSV export content type drifted'
	);
	assert(
		csv.response.headers.get('content-disposition')?.includes('.csv'),
		'CSV export filename drifted'
	);
	assert(
		Buffer.from(csv.data).toString('utf8').startsWith('\uFEFF'),
		'CSV export lost its UTF-8 BOM'
	);

	const xlsx = await rawRequest(
		`/api/v1/widgets/${wheel.id}/leads/export?format=xlsx`,
		'behavior-user'
	);
	assert(
		xlsx.response.headers.get('content-type') ===
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'XLSX export content type drifted'
	);
	assert(
		xlsx.response.headers.get('content-disposition')?.includes('.xlsx'),
		'XLSX export filename drifted'
	);
	const magic = Buffer.from(xlsx.data).subarray(0, 2).toString('ascii');
	assert(magic === 'PK', 'XLSX export is not an Office ZIP archive');
	const workbook = XLSX.read(Buffer.from(xlsx.data), { type: 'buffer' });
	assert(
		workbook.SheetNames.length === 1 &&
			workbook.SheetNames[0] === 'Заявки',
		'XLSX export worksheet name drifted'
	);
	const sheet = workbook.Sheets[workbook.SheetNames[0]];
	const rows = XLSX.utils.sheet_to_json(sheet, {
		header: 1,
		defval: ''
	});
	const expectedHeaders = [
		'№',
		'Дата',
		'Телефон',
		'Email',
		'Бонус',
		'Страница'
	];
	assert(
		rows.length === 3 &&
			Array.isArray(rows[0]) &&
			JSON.stringify(rows[0]) === JSON.stringify(expectedHeaders),
		'XLSX export rows or headers drifted'
	);
	const exportedRows = rows.slice(1);
	assert(
		exportedRows.every(
			row => Array.isArray(row) && typeof row[1] === 'string' && row[1]
		),
		'XLSX export dates are missing'
	);
	assert(
		JSON.stringify(exportedRows.map(row => row[2]).sort()) ===
			JSON.stringify(['+79990000001', '+79990000008']),
		'XLSX export phones drifted'
	);
	assert(
		JSON.stringify(exportedRows.map(row => row[4]).sort()) ===
			JSON.stringify(['10%', '20%']),
		'XLSX export bonuses drifted'
	);
	assert(
		JSON.stringify(exportedRows.map(row => row[5]).sort()) ===
			JSON.stringify([
				'https://shop.example.test/wheel',
				'https://shop.example.test/wheel-2'
			]),
		'XLSX export URLs drifted'
	);
}

async function assertLifecycle(wheel) {
	const updated = await jsonRequest(`/api/v1/widgets/${wheel.id}`, {
		method: 'PATCH',
		token: 'behavior-user',
		body: {
			expectedDraftRevision: wheel.draftRevision,
			config: { title: 'Behavior wheel version two' }
		},
		correlationId: nextCorrelation('lifecycle-update')
	});
	const published = await publish({ ...wheel, ...updated });
	assert(
		published.publishedVersion === 2,
		'Second widget version was not published'
	);

	const pageOne = await jsonRequest(
		`/api/v1/widget-settings/wheel/${wheel.id}/versions?page=1&limit=1`,
		{ token: 'behavior-user' }
	);
	const pageTwo = await jsonRequest(
		`/api/v1/widget-settings/wheel/${wheel.id}/versions?page=2&limit=1`,
		{ token: 'behavior-user' }
	);
	assert(
		pageOne.total === 2 &&
			pageOne.totalPages === 2 &&
			pageOne.items[0].version === 2,
		'Version pagination metadata drifted'
	);
	assert(
		pageTwo.items[0].version === 1,
		'Version pagination did not return the older revision'
	);

	const restored = await jsonRequest(
		`/api/v1/widget-settings/wheel/${wheel.id}/versions/1/restore`,
		{
			method: 'POST',
			token: 'behavior-user',
			body: { expectedDraftRevision: published.draftRevision },
			correlationId: nextCorrelation('restore')
		}
	);
	assert(
		restored.hasUnpublishedChanges === true &&
			restored.draftRevision === published.draftRevision + 1,
		'Version restore did not create a draft'
	);
	const discarded = await jsonRequest(
		`/api/v1/widget-settings/wheel/${wheel.id}/discard-draft`,
		{
			method: 'POST',
			token: 'behavior-user',
			body: { expectedDraftRevision: restored.draftRevision },
			correlationId: nextCorrelation('discard')
		}
	);
	assert(
		discarded.status === 'PUBLISHED' &&
			discarded.hasUnpublishedChanges === false,
		'Draft discard did not restore published state'
	);

	const clone = await jsonRequest(
		`/api/v1/widget-settings/wheel/${wheel.id}/clone`,
		{
			method: 'POST',
			token: 'behavior-user',
			expectedStatus: 201,
			body: { name: 'Behavior wheel clone' },
			correlationId: nextCorrelation('clone')
		}
	);
	assert(
		clone.type === 'wheel' && typeof clone.id === 'string',
		'Widget clone response drifted'
	);
	const cloneList = await jsonRequest('/api/v1/widgets', {
		token: 'behavior-user'
	});
	assert(
		cloneList.widgets.some(
			item => item.id === clone.id && item.isActive === false
		),
		'Cloned widget is missing or active'
	);
	await jsonRequest(`/api/v1/widgets/${clone.id}`, {
		method: 'DELETE',
		token: 'behavior-user',
		correlationId: nextCorrelation('clone-delete')
	});

	Object.assign(wheel, discarded, { publishedVersion: 2 });
}

async function assertRuntimeTelemetry(widgets) {
	for (const definition of CASES) {
		const widget = widgets[definition.key];
		await runtimeEvent(widget, 'IMPRESSION');
		const status = await jsonRequest(
			`/api/v1/widget-runtime/${widget.type}/${widget.id}/status`,
			{ token: 'behavior-user' }
		);
		assert(
			status.installation?.state === 'SIGNAL_RECEIVED',
			`${widget.type} runtime status did not observe the signal`
		);
	}

	await jsonRequest(
		`/api/v1/widget-events/ai-consultant/${widgets.aiConsultant.publicKey}`,
		{
			method: 'POST',
			expectedStatus: 204,
			publicRequest: true,
			headers: {
				origin: 'https://winwidget.ru',
				referer: `https://winwidget.ru/page-ai-consultant/${widgets.aiConsultant.publicKey}`
			},
			body: {
				event: 'START',
				runtimeVersion: 'behavior-v1',
				publishedVersion: widgets.aiConsultant.publishedVersion
			}
		}
	);
	const aiAnalytics = await jsonRequest(
		`/api/v1/widget-runtime/ai-consultant/${widgets.aiConsultant.id}/analytics?days=7`,
		{ token: 'behavior-user' }
	);
	assert(
		aiAnalytics.totals.starts === 1 &&
			aiAnalytics.submitAvailable === false &&
			aiAnalytics.completionLabel === 'Завершения',
		'AI direct-page telemetry or completion semantics drifted'
	);

	for (const event of ['OPEN', 'START', 'COMPLETE'])
		await runtimeEvent(widgets.wheel, event);
	const wheelAnalytics = await jsonRequest(
		`/api/v1/widget-runtime/wheel/${widgets.wheel.id}/analytics?days=7`,
		{ token: 'behavior-user' }
	);
	assert(
		wheelAnalytics.totals.impressions === 1 &&
			wheelAnalytics.totals.opens === 1 &&
			wheelAnalytics.totals.starts === 1 &&
			wheelAnalytics.totals.submits === 1,
		'Runtime analytics totals drifted'
	);

	await runtimeEvent(widgets.quiz, 'START');
	await runtimeEvent(widgets.quiz, 'STEP', 'question:1');
	await runtimeEvent(widgets.quiz, 'COMPLETE');
	const quizAnalytics = await jsonRequest(
		`/api/v1/widget-runtime/quiz/${widgets.quiz.id}/analytics?days=7`,
		{ token: 'behavior-user' }
	);
	assert(
		quizAnalytics.steps[0]?.key === 'question:1' &&
			quizAnalytics.steps[0]?.count === 1,
		'Quiz step analytics drifted'
	);
}

async function runtimeEvent(widget, event, stepKey) {
	const publicType =
		widget.type === 'wheel' ? widget.type : widget.publicApi;
	await jsonRequest(
		`/api/v1/widget-events/${publicType}/${widget.publicKey}`,
		{
			method: 'POST',
			expectedStatus: 204,
			publicRequest: true,
			body: {
				event,
				runtimeVersion: 'behavior-v1',
				publishedVersion: widget.publishedVersion,
				...(stepKey && { stepKey })
			}
		}
	);
}

async function assertAdminMonitoringAndAudit(wheel) {
	const adminUpdate = await jsonRequest(
		`/api/v1/widgets/admin/wheel/${wheel.id}`,
		{
			method: 'PATCH',
			token: 'behavior-dev',
			body: { name: 'Behavior admin-updated wheel' },
			correlationId: nextCorrelation('admin-update')
		}
	);
	assert(
		adminUpdate.type === 'WHEEL' &&
			adminUpdate.entity?.name === 'Behavior admin-updated wheel',
		'Admin widget update response drifted'
	);

	const monitoring = await jsonRequest(
		'/api/v1/widgets/admin/monitoring?page=1&limit=2',
		{ token: 'behavior-dev' }
	);
	assert(
		monitoring.page === 1 &&
			monitoring.limit === 2 &&
			monitoring.total === 7 &&
			monitoring.items.length === 2,
		'Admin monitoring pagination drifted'
	);
	assert(
		monitoring.items.every(item => item.owner?.id === primaryOwnerId),
		'Admin monitoring owner federation drifted'
	);
	const detail = await jsonRequest(
		`/api/v1/widgets/admin/wheel/${wheel.id}`,
		{ token: 'behavior-dev' }
	);
	assert(
		detail.owner?.id === primaryOwnerId && detail.ownerPlan === 'HARD',
		'Admin widget detail federation drifted'
	);

	const audits = await prisma.widgetsOutboxEvent.findMany({
		where: { eventType: 'admin.audit.event.v1' },
		select: { routingKey: true, payload: true }
	});
	assert(
		audits.some(
			item =>
				item.routingKey === 'admin.audit.widgets.v1' &&
				item.payload?.action === 'WIDGET_UPDATE' &&
				item.payload?.actorId === devActorId
		),
		'Admin mutation did not create the Widgets audit event'
	);
}

async function assertQuotaFailClosed() {
	await jsonRequest('/api/v1/widgets', {
		method: 'POST',
		token: 'behavior-missing-projection',
		expectedStatus: 503,
		body: { name: 'Must fail closed' },
		correlationId: nextCorrelation('fail-closed')
	});
	assert(
		(await prisma.widget.count({
			where: { userId: missingProjectionOwnerId }
		})) === 0,
		'Fail-closed quota created a widget'
	);
}

async function assertQuotaLimit() {
	const created = await jsonRequest('/api/v1/widgets', {
		method: 'POST',
		token: 'behavior-quota-user',
		expectedStatus: 201,
		body: { name: 'Quota widget' },
		correlationId: nextCorrelation('quota-create')
	});
	const updated = await jsonRequest(`/api/v1/widgets/${created.id}`, {
		method: 'PATCH',
		token: 'behavior-quota-user',
		body: {
			expectedDraftRevision: created.draftRevision,
			installDomain: 'shop.example.test'
		},
		correlationId: nextCorrelation('quota-update')
	});
	const published = await jsonRequest(
		`/api/v1/widget-settings/wheel/${created.id}/publish`,
		{
			method: 'POST',
			token: 'behavior-quota-user',
			body: { expectedDraftRevision: updated.draftRevision },
			correlationId: nextCorrelation('quota-publish')
		}
	);
	const submitted = await jsonRequest(
		`/api/v1/widget/${published.publicKey}/lead`,
		{
			method: 'POST',
			expectedStatus: 201,
			publicRequest: true,
			body: { phone: '+79990000101' },
			correlationId: nextCorrelation('quota-lead')
		}
	);
	assert(submitted.success === true, 'Quota boundary first lead failed');
	const blockedConfig = await jsonRequest(
		`/api/v1/widget/${published.publicKey}/config`,
		{ publicRequest: true }
	);
	assert(
		blockedConfig.isActive === false,
		'Public config did not fail closed at the lead limit'
	);
	await jsonRequest(`/api/v1/widget/${published.publicKey}/lead`, {
		method: 'POST',
		expectedStatus: 403,
		publicRequest: true,
		body: { phone: '+79990000102' },
		correlationId: nextCorrelation('quota-block')
	});
	const counter = await usage(quotaOwnerId);
	assert(
		counter.widgetCount === 1 && counter.leadCount === 1,
		'Quota counter was not advanced exactly once'
	);
	await jsonRequest(`/api/v1/widgets/${created.id}`, {
		method: 'DELETE',
		token: 'behavior-quota-user',
		correlationId: nextCorrelation('quota-delete')
	});
}

async function assertOwnerDeactivationBlocksPublic(wheel) {
	await prisma.widgetOwnerProjection.update({
		where: { userId: primaryOwnerId },
		data: { status: 'DEACTIVATED', sourceOccurredAt: new Date() }
	});
	owners.set(primaryOwnerId, owner(primaryOwnerId, 'HARD', 'DEACTIVATED'));
	const config = await publicConfig(wheel);
	assert(
		config.isActive === false,
		'Deactivated owner still has an active public config'
	);
	await jsonRequest(`/api/v1/widget/${wheel.publicKey}/lead`, {
		method: 'POST',
		expectedStatus: 403,
		publicRequest: true,
		body: { phone: '+79990000150' },
		correlationId: nextCorrelation('owner-block')
	});
	await prisma.widgetOwnerProjection.update({
		where: { userId: primaryOwnerId },
		data: { status: 'ACTIVE', sourceOccurredAt: new Date() }
	});
	owners.set(primaryOwnerId, owner(primaryOwnerId, 'HARD'));
}

async function assertUsageCounters(expectedLeadCount) {
	const counter = await usage(primaryOwnerId);
	assert(
		counter.widgetCount === 7 && counter.leadCount === expectedLeadCount,
		'Primary usage counter drifted'
	);
	const leadLedger = await prisma.widgetUsageLedgerEntry.count({
		where: { userId: primaryOwnerId, kind: 'LEAD' }
	});
	assert(
		leadLedger === expectedLeadCount,
		'Lead usage ledger did not record every accepted lead'
	);
}

async function deleteAllWidgets(widgets, expectedLeadCount) {
	for (const definition of CASES) {
		const widget = widgets[definition.key];
		const deleted = await jsonRequest(
			`/api/v1/${definition.collection}/${widget.id}`,
			{
				method: 'DELETE',
				token: 'behavior-user',
				correlationId: nextCorrelation('delete')
			}
		);
		assert(
			deleted.id === widget.id,
			`${definition.type} delete response drifted`
		);
	}
	const counter = await usage(primaryOwnerId);
	assert(
		counter.widgetCount === 0 && counter.leadCount === expectedLeadCount,
		'Widget deletion corrupted usage counters'
	);
	assert(
		s3Requests.some(
			item =>
				item.method === 'DELETE' &&
				item.path.includes(`/widget-buttons/wheel/${widgets.wheel.id}/`)
		),
		'Deleting the image-owning widget did not remove its fake S3 object'
	);
}

async function prepareDatabase() {
	await seedOwner(primaryOwnerId, {
		unlimited: true,
		maxWidgets: 20,
		maxLeadsPerPeriod: null
	});
	await seedOwner(quotaOwnerId, {
		unlimited: false,
		maxWidgets: 2,
		maxLeadsPerPeriod: 1
	});
}

async function seedOwner(userId, quota) {
	const now = new Date();
	const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
	await prisma.$transaction([
		prisma.widgetOwnerProjection.create({
			data: {
				userId,
				status: 'ACTIVE',
				aggregateVersion: 1n,
				sourceSequence: 1n,
				sourceOccurredAt: now
			}
		}),
		prisma.widgetEntitlementProjection.create({
			data: {
				id: `subscription-${userId}`,
				userId,
				plan: 'HARD',
				billingPeriod: 'MONTHLY',
				status: 'ACTIVE',
				startsAt: new Date(now.getTime() - 60_000),
				expiresAt: future,
				periodResetsAt: future,
				maxWidgets: quota.maxWidgets,
				maxLeadsPerPeriod: quota.maxLeadsPerPeriod,
				unlimited: quota.unlimited,
				aggregateVersion: 1n,
				sourceSequence: 1n,
				sourceOccurredAt: now,
				sourceCreatedAt: now,
				sourceUpdatedAt: now
			}
		}),
		prisma.widgetUsageCounter.create({
			data: {
				userId,
				widgetCount: 0,
				leadCount: 0,
				leadPeriodKey: future.toISOString(),
				leadPeriodStartsAt: now,
				leadPeriodEndsAt: future,
				entitlementVersion: 1n
			}
		})
	]);
}

async function assertCleanDatabase() {
	const counts = await Promise.all(
		[
			['widgets', prisma.widget.count()],
			['quizzes', prisma.quiz.count()],
			['callbacks', prisma.callback.count()],
			['timers', prisma.countdownTimer.count()],
			['stopOffers', prisma.stopOffer.count()],
			['consultants', prisma.aiConsultant.count()],
			['aiConsentReceipts', prisma.aiConsentReceipt.count()],
			['calculators', prisma.calculator.count()],
			['revisions', prisma.widgetConfigRevision.count()],
			['runtimePresence', prisma.widgetRuntimePresence.count()],
			['runtimeMetrics', prisma.widgetRuntimeDailyMetric.count()],
			['runtimeStepMetrics', prisma.widgetRuntimeDailyStepMetric.count()],
			['entitlements', prisma.widgetEntitlementProjection.count()],
			['usageCounters', prisma.widgetUsageCounter.count()],
			['usageLedger', prisma.widgetUsageLedgerEntry.count()],
			['owners', prisma.widgetOwnerProjection.count()],
			['aggregateVersions', prisma.widgetAggregateVersion.count()],
			['outbox', prisma.widgetsOutboxEvent.count()],
			['consumerReceipts', prisma.widgetsConsumerReceipt.count()],
			['consumerFailures', prisma.widgetsConsumerFailure.count()],
			[
				'credentialSnapshots',
				prisma.integrationCredentialSnapshot.count()
			],
			['deliveryReceipts', prisma.integrationDeliveryReceipt.count()],
			['deliveryFailures', prisma.integrationDeliveryFailure.count()]
		].map(async ([name, pending]) => [name, await pending])
	);
	const dirty = counts.filter(([, count]) => count !== 0);
	if (dirty.length) {
		throw new Error(
			`WIDGETS_TEST_DATABASE_URL must be clean; non-empty tables: ${dirty.map(([name, count]) => `${name}=${count}`).join(', ')}`
		);
	}
	const identity = await prisma.widgetsServiceIdentity.findUnique({
		where: { id: 'widgets-service' }
	});
	const sequence = await prisma.widgetSourceSequence.findUnique({
		where: { id: 'reporting' }
	});
	assert(
		identity &&
			identity.id === 'widgets-service' &&
			typeof identity.databaseId === 'string' &&
			identity.databaseId.length > 0,
		'Widgets service identity is not in the clean post-migration state'
	);
	assert(
		sequence?.lastValue === 0n,
		'Widgets reporting sequence is not in the clean post-migration state'
	);
}

async function cleanupDatabase() {
	await prisma.$transaction([
		prisma.aiConsentReceipt.deleteMany(),
		prisma.widgetConfigRevision.deleteMany(),
		prisma.widgetRuntimeDailyStepMetric.deleteMany(),
		prisma.widgetRuntimeDailyMetric.deleteMany(),
		prisma.widgetRuntimePresence.deleteMany(),
		prisma.widget.deleteMany(),
		prisma.quiz.deleteMany(),
		prisma.callback.deleteMany(),
		prisma.countdownTimer.deleteMany(),
		prisma.stopOffer.deleteMany(),
		prisma.aiConsultant.deleteMany(),
		prisma.calculator.deleteMany(),
		prisma.integrationDeliveryFailure.deleteMany(),
		prisma.integrationDeliveryReceipt.deleteMany(),
		prisma.integrationCredentialSnapshot.deleteMany(),
		prisma.widgetsConsumerFailure.deleteMany(),
		prisma.widgetsConsumerReceipt.deleteMany(),
		prisma.widgetsOutboxEvent.deleteMany(),
		prisma.widgetUsageLedgerEntry.deleteMany(),
		prisma.widgetUsageCounter.deleteMany(),
		prisma.widgetEntitlementProjection.deleteMany(),
		prisma.widgetOwnerProjection.deleteMany(),
		prisma.widgetAggregateVersion.deleteMany(),
		prisma.widgetSourceSequence.upsert({
			where: { id: 'reporting' },
			create: { id: 'reporting', lastValue: 0n },
			update: { lastValue: 0n }
		})
	]);
	const createdHeartbeats = await prisma.widgetsHeartbeat.findMany({
		where: baselineHeartbeatIds.length
			? { id: { notIn: baselineHeartbeatIds } }
			: {},
		select: { id: true }
	});
	if (createdHeartbeats.length) {
		await prisma.widgetsHeartbeat.deleteMany({
			where: { id: { in: createdHeartbeats.map(item => item.id) } }
		});
	}
}

function createIdentityServer() {
	return createServer(async (request, response) => {
		try {
			if (
				request.headers['x-winwidget-service'] !== 'widgets' ||
				request.headers['x-winwidget-internal-token'] !== identityToken
			) {
				return sendJson(response, 403, { message: 'forbidden' });
			}
			if (
				request.method === 'POST' &&
				request.url === '/internal/v1/auth/introspect'
			) {
				const value = actorTokens.get(
					String(request.headers.authorization || '').replace(
						/^Bearer\s+/i,
						''
					)
				);
				return value
					? sendJson(response, 200, value)
					: sendJson(response, 401, { message: 'unauthorized' });
			}
			if (
				request.method === 'POST' &&
				request.url === '/internal/v1/widgets/owners/resolve'
			) {
				const body = await readJson(request);
				return sendJson(response, 200, {
					items: body.userIds.map(id => owners.get(id)).filter(Boolean)
				});
			}
			if (
				request.method === 'POST' &&
				request.url === '/internal/v1/widgets/owners/search'
			) {
				const body = await readJson(request);
				const items = [...owners.values()]
					.filter(item => !body.afterId || item.id > body.afterId)
					.sort((left, right) => left.id.localeCompare(right.id))
					.slice(0, body.limit || 100);
				return sendJson(response, 200, { items, nextAfterId: null });
			}
			return sendJson(response, 404, { message: 'not found' });
		} catch (error) {
			return sendJson(response, 500, {
				message:
					error instanceof Error ? error.message : 'fake Identity failed'
			});
		}
	});
}

function createS3Server() {
	return createServer(async (request, response) => {
		try {
			const method = request.method || '';
			const path = new URL(request.url || '/', 'http://127.0.0.1')
				.pathname;
			if (method === 'GET') {
				const object = s3Objects.get(path);
				if (!object) {
					response.writeHead(404).end();
					return;
				}
				s3Requests.push({
					method,
					path,
					bytes: object.body.length,
					contentType: object.contentType
				});
				response.writeHead(200, {
					'cache-control': 'no-store',
					'content-type': object.contentType
				});
				response.end(object.body);
				return;
			}
			if (!['PUT', 'DELETE'].includes(method)) {
				response.writeHead(405).end();
				return;
			}
			const body = await readBody(request, 300 * 1024);
			const contentType =
				request.headers['content-type'] || 'application/octet-stream';
			s3Requests.push({
				method,
				path,
				bytes: body.length,
				contentType
			});
			if (method === 'PUT') {
				s3Objects.set(path, { body, contentType });
			} else {
				s3Objects.delete(path);
			}
			response.writeHead(200, { etag: '"widgets-behavior-etag"' }).end();
		} catch {
			response.writeHead(500).end();
		}
	});
}

function createCloudflareServer() {
	return createServer(async (request, response) => {
		try {
			const path = new URL(request.url || '/', 'http://127.0.0.1')
				.pathname;
			const turnstileWidgetPath =
				'/client/v4/accounts/behavior_account_123/challenges/widgets/behavior-turnstile-site-key';
			if (request.method === 'GET' && path === turnstileWidgetPath) {
				return sendJson(response, 200, {
					success: true,
					result: {
						name: 'WinWidget behavior AI',
						mode: 'managed',
						clearance_level: 'no_clearance'
					}
				});
			}
			if (request.method === 'PUT' && path === turnstileWidgetPath) {
				const body = await readJson(request);
				if (
					request.headers.authorization !==
						'Bearer behavior-cloudflare-token' ||
					body.name !== 'WinWidget behavior AI' ||
					body.mode !== 'managed' ||
					body.clearance_level !== 'no_clearance' ||
					!Array.isArray(body.domains) ||
					!body.domains.includes('winwidget.ru')
				) {
					return sendJson(response, 400, { success: false });
				}
				turnstileRequests.push({ operation: 'hostname-sync', body });
				return sendJson(response, 200, {
					success: true,
					result: { domains: body.domains }
				});
			}
			if (
				request.method === 'POST' &&
				path === '/turnstile/v0/siteverify'
			) {
				const body = await readJson(request);
				const rawToken = String(body.response || '');
				const challenge = rawToken.match(
					/^turnstile-(browser-|direct-)?([a-f0-9]{12})(?:-[1-9][0-9]*)?$/
				);
				const browserChallenge = challenge?.[1] === 'browser-';
				const directChallenge = challenge?.[1] === 'direct-';
				const publicKey = challenge?.[2] || '';
				if (
					body.secret !== 'behavior-turnstile-secret-key' ||
					usedTurnstileTokens.has(body.response) ||
					!/^[a-f0-9]{12}$/.test(publicKey)
				) {
					return sendJson(response, 200, { success: false });
				}
				usedTurnstileTokens.add(body.response);
				turnstileRequests.push({ operation: 'siteverify' });
				return sendJson(response, 200, {
					success: true,
					action: 'ai-consultant-session',
					cdata: publicKey,
					hostname:
						browserChallenge || directChallenge
							? 'localhost'
							: 'shop.example.test',
					challenge_ts: new Date().toISOString()
				});
			}
			if (
				request.method !== 'POST' ||
				path !== '/client/v4/accounts/behavior_account_123/ai/run'
			) {
				return sendJson(response, 404, { success: false });
			}
			const body = await readJson(request);
			if (
				request.headers.authorization !==
					'Bearer behavior-cloudflare-token' ||
				request.headers['cf-aig-gateway-id'] !== 'behavior-ai-gateway' ||
				request.headers['cf-aig-collect-log'] !== 'false' ||
				request.headers['cf-aig-collect-log-payload'] !== 'false' ||
				request.headers['cf-aig-skip-cache'] !== 'true' ||
				body.model !== '@cf/qwen/qwen3-30b-a3b-fp8' ||
				!Array.isArray(body.input?.messages)
			) {
				return sendJson(response, 400, { success: false });
			}
			cloudflareRequests.push({
				model: body.model,
				messageCount: body.input.messages.length,
				maxTokens: body.input.max_tokens,
				noThinking: String(body.input.messages.at(-1)?.content || '')
					.trimEnd()
					.endsWith('/no_think'),
				payloadLogging: request.headers['cf-aig-collect-log-payload']
			});
			const verifier = String(
				body.input.messages[0]?.content || ''
			).includes('GROUNDING_VERIFIER_V1');
			return sendJson(response, 200, {
				success: true,
				result: {
					response: verifier
						? JSON.stringify({ supported: true })
						: JSON.stringify({
								outcome: 'ANSWER',
								reply: 'Цена товара Behavior составляет 1000 рублей.',
								evidence: 'Товар Behavior стоит 1000 рублей.'
							})
				}
			});
		} catch (error) {
			return sendJson(response, 500, { success: false });
		}
	});
}

function actor(subject, roles) {
	return { active: true, subject, sessionId: `session-${subject}`, roles };
}

function owner(id, plan, status = 'ACTIVE') {
	const now = new Date();
	return {
		id,
		name: `Owner ${id.slice(-6)}`,
		status,
		deletedAt: null,
		rights: ['USER'],
		email: `${id}@example.test`,
		phone: '+79990000999',
		subscription: {
			id: `subscription-${id}`,
			plan,
			billingPeriod: 'MONTHLY',
			status: 'ACTIVE',
			startsAt: new Date(now.getTime() - 60_000).toISOString(),
			expiresAt: new Date(
				now.getTime() + 30 * 24 * 60 * 60 * 1000
			).toISOString(),
			periodResetsAt: new Date(
				now.getTime() + 30 * 24 * 60 * 60 * 1000
			).toISOString(),
			createdAt: now.toISOString(),
			updatedAt: now.toISOString()
		}
	};
}

async function usage(userId) {
	const counter = await prisma.widgetUsageCounter.findUnique({
		where: { userId }
	});
	assert(counter, `Usage counter is missing for ${userId}`);
	return counter;
}

async function jsonRequest(path, options = {}) {
	const headers = {
		...(options.token
			? authenticatedHeaders(options.token, options.correlationId)
			: {}),
		...(options.publicRequest
			? {
					origin: 'https://shop.example.test',
					referer: 'https://shop.example.test/page'
				}
			: {}),
		...(options.correlationId && !options.token
			? { 'x-correlation-id': options.correlationId }
			: {}),
		...(options.headers || {})
	};
	if (options.body !== undefined)
		headers['content-type'] = 'application/json';
	const response = await fetch(url(path), {
		method: options.method || 'GET',
		headers,
		...(options.body !== undefined && {
			body: JSON.stringify(options.body)
		}),
		signal: AbortSignal.timeout(10_000)
	});
	const payload = await parseResponse(response);
	assertStatus(
		response,
		options.expectedStatus || 200,
		`${options.method || 'GET'} ${path}`,
		payload
	);
	return payload;
}

async function rawRequest(path, token) {
	const response = await fetch(url(path), {
		headers: authenticatedHeaders(token),
		signal: AbortSignal.timeout(10_000)
	});
	const data = await response.arrayBuffer();
	assertStatus(response, 200, `GET ${path}`, `bytes=${data.byteLength}`);
	return { response, data };
}

function authenticatedHeaders(token, correlationId) {
	return {
		authorization: `Bearer ${token}`,
		...(correlationId && { 'x-correlation-id': correlationId })
	};
}

async function parseResponse(response) {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function assertStatus(response, expected, context, payload) {
	if (response.status !== expected) {
		throw new Error(
			`${context} returned ${response.status}, expected ${expected}: ${safePayload(payload)}`
		);
	}
}

function safePayload(payload) {
	const value =
		typeof payload === 'string' ? payload : JSON.stringify(payload);
	return value.slice(0, 500);
}

function url(path) {
	return `http://127.0.0.1:${appPort}${path}`;
}

function nextCorrelation(label) {
	mutationIndex += 1;
	return `widgets-behavior-${runId}-${label}-${mutationIndex}`;
}

async function waitForReady() {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (app.exitCode !== null)
			throw new Error(
				`Widgets behavior process exited with ${app.exitCode}`
			);
		try {
			const response = await fetch(url('/health/ready'), {
				signal: AbortSignal.timeout(1000)
			});
			if (response.ok) return;
		} catch {
			// The loopback listener is expected to refuse connections during bootstrap.
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Widgets behavior service did not become ready');
}

async function listenLoopback(server) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string')
		throw new Error('Could not allocate a loopback server port');
	return address.port;
}

async function reservePort() {
	const server = createServer();
	const port = await listenLoopback(server);
	await closeServer(server);
	return port;
}

async function stopChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null)
		return;
	child.kill('SIGTERM');
	const result = await Promise.race([
		new Promise(resolve => child.once('exit', code => resolve(code))),
		new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
	]);
	if (result === 'timeout') {
		child.kill('SIGKILL');
		await new Promise(resolve => child.once('exit', resolve));
		throw new Error('Widgets behavior process did not stop gracefully');
	}
}

async function closeServer(server) {
	if (!server.listening) return;
	await new Promise((resolve, reject) => {
		server.close(error => (error ? reject(error) : resolve()));
		server.closeAllConnections?.();
	});
}

async function captureCleanupError(errors, operation) {
	try {
		await operation();
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
}

function sendJson(response, status, payload) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(payload));
}

async function readJson(request) {
	const body = await readBody(request, 64 * 1024);
	return JSON.parse(body.toString('utf8'));
}

async function readBody(request, maxBytes) {
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		total += chunk.length;
		if (total > maxBytes)
			throw new Error('Fake service request exceeded its local limit');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function transparentPng() {
	return Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
		'base64'
	);
}

function cuidLikeId() {
	return `c${randomBytes(12).toString('hex')}`;
}

function assertAiConsentConfig(consent, privacyUrl) {
	let parsedPrivacyUrl;
	try {
		parsedPrivacyUrl = new URL(consent?.privacyUrl);
	} catch {
		parsedPrivacyUrl = null;
	}
	assert(
		consent &&
			/^[a-z0-9][a-z0-9._-]{0,63}$/.test(consent.documentVersion) &&
			/^[a-f0-9]{64}$/.test(consent.documentHash) &&
			typeof consent.statementText === 'string' &&
			consent.statementText.trim().length > 0 &&
			parsedPrivacyUrl &&
			['http:', 'https:'].includes(parsedPrivacyUrl.protocol) &&
			!parsedPrivacyUrl.username &&
			!parsedPrivacyUrl.password &&
			consent.privacyUrl === privacyUrl,
		'AI consultant public consent config drifted'
	);
}

function assertAiConsentResponse(response, acceptanceId, context) {
	const acceptedAt = Date.parse(response?.acceptedAt);
	const expiresAt = Date.parse(response?.expiresAt);
	assert(
		response?.acceptanceId === acceptanceId &&
			typeof response.consentToken === 'string' &&
			/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(response.consentToken) &&
			response.consentToken.length <= 3072 &&
			Number.isFinite(acceptedAt) &&
			Number.isFinite(expiresAt) &&
			expiresAt - acceptedAt === 15 * 60 * 1000 &&
			Object.keys(response).sort().join(',') ===
				'acceptanceId,acceptedAt,consentToken,expiresAt',
		`${context} consent response drifted`
	);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertLocalTestDatabase(value) {
	const parsed = new URL(value);
	const databaseName = decodeURIComponent(
		parsed.pathname.replace(/^\/+/, '')
	);
	if (
		parsed.protocol !== 'postgresql:' ||
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		!(
			databaseName.toLowerCase().includes('test') ||
			databaseName.toLowerCase().endsWith('_ci')
		)
	) {
		throw new Error(
			'WIDGETS_TEST_DATABASE_URL must point to a local test or CI database'
		);
	}
	for (const [key, configured] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && configured?.trim() === value) {
			throw new Error(`WIDGETS_TEST_DATABASE_URL must not reuse ${key}`);
		}
	}
}
