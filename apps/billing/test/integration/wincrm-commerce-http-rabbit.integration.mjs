import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const EVENT = 'billing.wincrm.provider-operation.requested.v1';
const MAIN = 'winwidget.billing.wincrm-provider.v1';
const DEAD = 'winwidget.billing.wincrm-provider.dead-letter';
const SINK = 'wincrm.commerce.other-events.ci';
const UUID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Test composition only: all business commands, owner checks, leases, provider
// dispatch and settlement use real service classes and HTTP. Only the external
// provider transport is bridged to a server owned by this invocation.
export async function verifyWincrmCommerceHttpRabbit({
	servicesRoot,
	runId,
	apiUrl,
	account,
	secondaryAccount,
	billingDatabaseUrl,
	billingEnvironment,
	broker,
	changeSyntheticOwner,
	registerSecret: addSecret,
	log
}) {
	let phase = 'configuration';
	const registerSecret = value => {
		if (typeof value === 'string' && value.length > 0) addSecret(value);
	};
	const advance = value => {
		phase = value;
		log(`Billing HTTP proof phase=${phase}`);
	};
	const bounded = async (promise, timeoutMs = 15000) => {
		let timer;
		try {
			return await Promise.race([
				promise,
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('Owned dependency timed out')),
						timeoutMs
					);
				})
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	let db,
		inspector,
		inspectorChannel,
		publisherRabbit,
		workerRabbit,
		worker,
		publisher;
	let providerServer, sinkTag, aclProbe;
	let ownerRevoked = false;
	let releaseFirstRequest;
	let sinkCount = 0,
		reverseAllowed = 0,
		reverseDenied = 0;
	let providerGetCount = 0,
		providerReceiptCount = 0;
	let firstRequestWaiting = false,
		handlerFailure = false;
	const inflight = new Set();
	const deliveryCounts = new Map();
	const previousEnvironment = new Map();
	const originalFetch = globalThis.fetch;
	const deadline = Date.now() + 120_000;
	const requests = new Map();
	const paymentById = new Map();
	const approvedOrders = new Set();
	const setEnvironment = values => {
		for (const [key, value] of Object.entries(values)) {
			if (!previousEnvironment.has(key))
				previousEnvironment.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	const pause = () => new Promise(resolve => setTimeout(resolve, 50));
	const until = async predicate => {
		while (Date.now() < deadline) {
			assert.ok(
				!handlerFailure,
				'Synthetic provider or worker assertion failed'
			);
			const result = await bounded(predicate(), 25000);
			if (result) return result;
			await pause();
		}
		throw new Error('Billing HTTP proof deadline exceeded');
	};
	const boundedJson = async response => {
		assert.ok(
			response.body &&
				response.headers.get('content-type')?.includes('application/json')
		);
		const chunks = [],
			reader = response.body.getReader();
		let length = 0;
		try {
			while (true) {
				const item = await reader.read();
				if (item.done) break;
				length += item.value.byteLength;
				if (length > 512 * 1024) {
					await reader.cancel();
					throw new Error('HTTP response limit');
				}
				chunks.push(item.value);
			}
		} finally {
			reader.releaseLock();
		}
		return JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(
				Buffer.concat(chunks, length)
			)
		);
	};
	const request = async (
		path,
		{ body, token, status = 200, commandId } = {}
	) => {
		const response = await fetch(apiUrl + path, {
			method: body ? 'POST' : 'GET',
			redirect: 'error',
			cache: 'no-store',
			signal: AbortSignal.timeout(15_000),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(commandId ? { 'Idempotency-Key': commandId } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== status) {
			await response.body?.cancel();
			const error = new Error('Unexpected local HTTP status');
			error.name = 'LocalHttpProofError';
			error.httpStatus = response.status;
			error.route = path.split('?')[0].replace(/[a-f0-9-]{36}/g, ':id');
			throw error;
		}
		return boundedJson(response);
	};
	const login = async user => {
		registerSecret(user.password);
		const result = await request('/auth/login', {
			body: { email: user.email, password: user.password }
		});
		assert.ok(
			result.user?.id === user.userId &&
				typeof result.accessToken === 'string' &&
				result.accessToken.length > 100
		);
		registerSecret(result.accessToken);
		return result.accessToken;
	};
	const pump = async predicate =>
		until(async () => {
			for (let index = 0; index < 20; index++)
				if (!(await bounded(publisher.publishOne(), 20000))) break;
			return predicate();
		});
	try {
		assert.match(runId, /^[a-f0-9]{10}$/);
		assert.equal(apiUrl, 'http://localhost:4100/api/v1');
		for (const [user, name] of [
			[account, 'billing'],
			[secondaryAccount, 'billingRevoked']
		]) {
			assert.equal(user.userId, `wincrm-local-${name}-${runId}`);
			assert.equal(
				user.email,
				`wincrm-${name.toLowerCase()}@example.test`
			);
			assert.match(user.workspaceId, UUID);
		}
		assert.notEqual(account.workspaceId, secondaryAccount.workspaceId);
		assert.equal(typeof changeSyntheticOwner, 'function');
		registerSecret(billingDatabaseUrl);
		const database = new URL(billingDatabaseUrl);
		registerSecret(database.password);
		registerSecret(decodeURIComponent(database.password));
		assert.ok(
			database.protocol === 'postgresql:' &&
				database.hostname === '127.0.0.1' &&
				database.port === '55440'
		);
		assert.ok(
			database.pathname ===
				`/winwidget_billing_test_browser_${runId}_test` &&
				decodeURIComponent(database.username) === `wcrm_billing_r_${runId}`
		);
		assert.ok(
			!database.hash &&
				database.searchParams.get('schema') === 'billing' &&
				database.searchParams.get('sslmode') === 'disable'
		);
		assert.ok(
			database.searchParams.getAll('schema').length === 1 &&
				database.searchParams.getAll('sslmode').length === 1 &&
				[...database.searchParams.keys()].every(key =>
					['schema', 'sslmode'].includes(key)
				)
		);
		const urls = ['provisioner', 'worker', 'publisher'].map(key => {
			registerSecret(broker[key]);
			const url = new URL(broker[key]);
			registerSecret(url.password);
			registerSecret(decodeURIComponent(url.password));
			assert.ok(
				url.protocol === 'amqp:' &&
					url.hostname === '127.0.0.1' &&
					url.port === '5673'
			);
			assert.ok(url.username && url.password && !url.search && !url.hash);
			assert.match(
				decodeURIComponent(url.pathname),
				/^\/[a-z0-9_-]+_(test|ci)$/
			);
			return url;
		});
		assert.ok(urls.every(url => url.pathname === urls[0].pathname));
		assert.equal(
			new Set(urls.map(url => decodeURIComponent(url.username))).size,
			3
		);
		assert.equal(
			billingEnvironment.BILLING_WINCRM_PAYMENTS_ENABLED,
			'true'
		);
		assert.equal(
			billingEnvironment.BILLING_CRM_ACCESS_COMMERCE_BASE_URL,
			'http://127.0.0.1:5300'
		);
		for (const key of [
			'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
			'PAYMENT_METHOD_ENCRYPTION_KEY'
		]) {
			assert.ok(
				typeof billingEnvironment[key] === 'string' &&
					billingEnvironment[key].length >= 32
			);
			registerSecret(billingEnvironment[key]);
		}
		const require = createRequire(
			join(servicesRoot, 'apps/billing/package.json')
		);
		require('reflect-metadata');
		const owned = file =>
			require(join(servicesRoot, `apps/billing/dist/src/${file}.js`));
		const { ConfigService } = require('@nestjs/config');
		const { PrismaClient } = require('@prisma/billing-client');
		const { BillingRuntimeService } = owned(
			'runtime/billing-runtime.service'
		);
		const { BillingRabbitMqService } = owned(
			'messaging/billing-rabbitmq.service'
		);
		const { BillingOutboxPublisherService } = owned(
			'messaging/billing-outbox-publisher.service'
		);
		const { WincrmProviderRabbitMqService } = owned(
			'provider/wincrm-provider-rabbitmq.service'
		);
		const { WincrmProviderWorkerService } = owned(
			'provider/wincrm-provider-worker.service'
		);
		const { WincrmAccessAuthorizationClient } = owned(
			'provider/wincrm-access-authorization.client'
		);
		const { WincrmCommerceService } = owned(
			'domain/wincrm-commerce.service'
		);
		const { PaymentMethodCryptoService } = owned(
			'provider/payment-method-crypto.service'
		);
		const { YooKassaService } = owned('provider/yookassa.service');
		db = new PrismaClient({
			datasources: { db: { url: billingDatabaseUrl } },
			log: []
		});
		assert.equal(
			await db.crmProviderOperation.count(),
			0,
			'Use a fresh HTTP-only fixture, not the PG fault-fixture profile'
		);
		const providerSecret = randomBytes(32).toString('hex');
		registerSecret(providerSecret);
		setEnvironment({
			...billingEnvironment,
			// Nest ConfigService in this service version prioritizes process.env.
			// The API fixture must not override the two explicit runtime roles below.
			BILLING_PROCESS_ROLE: undefined,
			MODE: 'test',
			YOOKASSA_SHOP_ID: '100001',
			YOOKASSA_SECRET_KEY: providerSecret,
			BILLING_WINCRM_PROVIDER_RABBITMQ_URL: broker.worker,
			BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY: 'false'
		});
		const expectedAuthorization = `Basic ${Buffer.from(`100001:${providerSecret}`).toString('base64')}`;
		registerSecret(expectedAuthorization);
		advance('synthetic-provider');
		providerServer = createServer((incoming, outgoing) => {
			void (async () => {
				assert.ok(incoming.socket.remoteAddress === '127.0.0.1');
				assert.ok(
					incoming.headers.authorization === expectedAuthorization
				);
				const url = new URL(incoming.url, 'http://127.0.0.1');
				const reply = value => {
					outgoing.writeHead(200, { 'content-type': 'application/json' });
					outgoing.end(JSON.stringify(value));
				};
				if (
					incoming.method === 'POST' &&
					url.pathname === '/v3/payments' &&
					!url.search
				) {
					const chunks = [];
					let length = 0;
					for await (const chunk of incoming) {
						length += chunk.length;
						assert.ok(length <= 32768);
						chunks.push(chunk);
					}
					const raw = Buffer.concat(chunks).toString('utf8'),
						body = JSON.parse(raw);
					const orderId = body.metadata?.paymentId;
					assert.ok(approvedOrders.has(orderId));
					assert.ok(
						body.metadata.productCode === 'WINCRM' &&
							body.metadata.plan === 'WINCRM' &&
							body.capture === true
					);
					const key = incoming.headers['idempotence-key'];
					assert.ok(typeof key === 'string' && /^[a-f0-9]{64}$/.test(key));
					const durable = await db.crmProviderOperation.findFirstOrThrow({
						where: { orderId, kind: 'CREATE' }
					});
					assert.ok(
						durable.status === 'PROCESSING' &&
							durable.firstDispatchAt &&
							durable.leaseToken &&
							durable.leaseUntil > new Date()
					);
					assert.ok(durable.idempotencyKey === key);
					const hash = createHash('sha256').update(raw).digest('hex');
					let prior = requests.get(orderId);
					if (prior) {
						assert.ok(prior.key === key && prior.hash === hash);
						prior.calls++;
					} else {
						prior = {
							key,
							hash,
							calls: 1,
							payment: {
								id: `synthetic-${randomUUID()}`,
								status: 'pending',
								paid: false,
								amount: body.amount,
								metadata: body.metadata
							}
						};
						prior.payment.confirmation = {
							confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${prior.payment.id}`
						};
						requests.set(orderId, prior);
						paymentById.set(prior.payment.id, prior.payment);
					}
					if (prior.calls === 1) {
						firstRequestWaiting = true;
						await new Promise(resolve => {
							releaseFirstRequest = resolve;
						});
						// Provider accepted the immutable key; transport loses the response.
						incoming.socket.destroy();
						return;
					}
					reply(prior.payment);
					return;
				}
				if (
					incoming.method === 'GET' &&
					/^\/v3\/payments\/[a-z0-9-]+$/.test(url.pathname) &&
					!url.search
				) {
					const payment = paymentById.get(url.pathname.split('/').at(-1));
					assert.ok(payment);
					providerGetCount++;
					reply({
						...payment,
						status: 'succeeded',
						paid: true,
						captured_at: new Date().toISOString()
					});
					return;
				}
				if (incoming.method === 'GET' && url.pathname === '/v3/receipts') {
					const id = url.searchParams.get('payment_id');
					assert.ok(
						paymentById.has(id) && url.searchParams.get('limit') === '100'
					);
					assert.ok(
						[...url.searchParams.keys()].every(key =>
							['payment_id', 'limit'].includes(key)
						)
					);
					providerReceiptCount++;
					reply({
						type: 'list',
						items: [
							{
								id: `receipt-${id}`,
								payment_id: id,
								status: 'succeeded',
								type: 'payment',
								registered_at: new Date().toISOString()
							}
						]
					});
					return;
				}
				throw new Error('Unexpected synthetic provider route');
			})().catch(() => {
				handlerFailure = true;
				outgoing.writeHead(500);
				outgoing.end();
			});
		});
		await new Promise((resolve, reject) => {
			providerServer.once('error', reject);
			providerServer.listen(0, '127.0.0.1', resolve);
		});
		const providerOrigin = `http://127.0.0.1:${providerServer.address().port}`;
		globalThis.fetch = async (input, options = {}) => {
			assert.ok(
				typeof input === 'string' || input instanceof URL,
				'Only explicit URL requests are allowed in this proof'
			);
			const url = new URL(input);
			assert.ok(!url.username && !url.password && !url.hash);
			if (url.origin === 'https://api.yookassa.ru') {
				assert.ok(
					options.redirect === 'error',
					'CRM provider redirects must be rejected'
				);
				assert.ok(
					url.pathname === '/v3/payments' ||
						/^\/v3\/payments\/[A-Za-z0-9._:-]+$/.test(url.pathname) ||
						url.pathname === '/v3/receipts'
				);
				return originalFetch(
					providerOrigin + url.pathname + url.search,
					options
				);
			}
			assert.ok(
				url.origin === 'http://localhost:4100' ||
					(url.origin === 'http://127.0.0.1:5300' &&
						url.pathname ===
							'/internal/v1/crm-access/billing/authorize-operation'),
				'Unexpected HTTP destination denied'
			);
			const response = await originalFetch(input, options);
			if (url.origin === 'http://127.0.0.1:5300') {
				log(
					`Billing HTTP proof reverse authorization HTTP ${response.status}`
				);
				if (response.status === 200) reverseAllowed++;
				else if (response.status === 403) reverseDenied++;
			}
			return response;
		};
		await assert.rejects(() =>
			fetch('https://unapproved.invalid/never-send')
		);
		await assert.rejects(() =>
			fetch('https://api.yookassa.ru.invalid/never-send')
		);
		advance('broker-topology');
		inspector = await bounded(
			require('amqplib').connect(broker.provisioner)
		);
		inspector.on('error', () => {});
		inspectorChannel = await inspector.createChannel();
		inspectorChannel.on('error', () => {});
		await inspectorChannel.assertExchange('winwidget.events', 'topic', {
			durable: true
		});
		await inspectorChannel.assertExchange(DEAD, 'direct', {
			durable: true
		});
		for (const [queue, exchange, route] of [
			[MAIN, 'winwidget.events', EVENT],
			[MAIN + '.dead-letter', DEAD, EVENT]
		]) {
			const state = await inspectorChannel.assertQueue(queue, {
				durable: true
			});
			assert.equal(state.messageCount, 0);
			assert.equal(state.consumerCount, 0);
			await inspectorChannel.bindQueue(queue, exchange, route);
		}
		const sink = await inspectorChannel.assertQueue(SINK, {
			durable: true
		});
		assert.equal(sink.messageCount, 0);
		assert.equal(sink.consumerCount, 0);
		const otherRoutes = [
			'billing.subscription.changed.v1',
			'billing.crm-entitlement.changed.v1',
			'admin.audit.billing.v1'
		];
		const existingRoutes = await db.outboxEvent.findMany({
			distinct: ['routingKey'],
			select: { routingKey: true }
		});
		assert.ok(
			existingRoutes.every(item => otherRoutes.includes(item.routingKey)),
			'Fresh HTTP fixture has unexpected pending domain routes'
		);
		for (const route of otherRoutes)
			await inspectorChannel.bindQueue(SINK, 'winwidget.events', route);
		sinkTag = (
			await inspectorChannel.consume(
				SINK,
				message => {
					if (!message) return;
					if (
						!otherRoutes.includes(message.fields.routingKey) ||
						message.properties.contentType !== 'application/json'
					)
						handlerFailure = true;
					sinkCount++;
					inspectorChannel.ack(message);
				},
				{ noAck: false }
			)
		).consumerTag;
		// Real negative ACL probes use separate channels: expected 403 closes each.
		advance('publisher-negative-acl');
		aclProbe = await bounded(require('amqplib').connect(broker.publisher));
		aclProbe.on('error', () => {});
		for (const action of ['configure', 'read']) {
			const channel = await aclProbe.createChannel();
			channel.on('error', () => {});
			await assert.rejects(
				action === 'configure'
					? channel.assertQueue(SINK, { durable: true })
					: channel.consume(SINK, () => {}, { noAck: false }),
				error => error?.code === 403
			);
			await channel.close().catch(() => undefined);
		}
		await bounded(aclProbe.close());
		aclProbe = null;
		const publisherConfig = new ConfigService({
			BILLING_PROCESS_ROLE: 'outbox-publisher',
			RABBITMQ_URL: broker.publisher,
			RABBITMQ_ASSERT_TOPOLOGY: 'false',
			RABBITMQ_CONNECTION_NAME: 'winwidget-billing-outbox-publisher'
		});
		const publisherRuntime = new BillingRuntimeService(publisherConfig);
		const workerRuntime = new BillingRuntimeService(
			new ConfigService({ BILLING_PROCESS_ROLE: 'worker' })
		);
		assert.equal(publisherRuntime.role, 'outbox-publisher');
		assert.equal(workerRuntime.role, 'worker');
		publisherRabbit = new BillingRabbitMqService(
			publisherConfig,
			publisherRuntime
		);
		publisherRabbit.logger = { log() {}, warn() {}, error() {} };
		advance('publisher-start');
		await bounded(publisherRabbit.onModuleInit(), 20000);
		assert.ok(
			publisherRabbit.isConnected() && publisherRabbit.isTopologyReady()
		);
		publisher = new BillingOutboxPublisherService(
			db,
			publisherRuntime,
			publisherRabbit
		);
		publisher.logger = { log() {}, warn() {}, error() {} };
		workerRabbit = new WincrmProviderRabbitMqService(workerRuntime);
		advance('worker-connection');
		await bounded(workerRabbit.onModuleInit(), 20000);
		const crypto = new PaymentMethodCryptoService();
		const commerce = new WincrmCommerceService(db, crypto);
		worker = new WincrmProviderWorkerService(
			workerRuntime,
			workerRabbit,
			commerce,
			new YooKassaService(),
			crypto,
			new WincrmAccessAuthorizationClient(workerRuntime),
			db
		);
		const handle = worker.handle.bind(worker);
		worker.handle = message => {
			const id = message.properties.messageId;
			deliveryCounts.set(id, (deliveryCounts.get(id) || 0) + 1);
			const promise = handle(message);
			inflight.add(promise);
			promise.then(
				() => inflight.delete(promise),
				() => {
					inflight.delete(promise);
					handlerFailure = true;
				}
			);
			return promise;
		};
		advance('worker-consume');
		await bounded(worker.onModuleInit());
		assert.ok(worker.isReady());
		advance('public-checkout');
		const token = await login(account),
			revokedToken = await login(secondaryAccount);
		const widgetsSubscriptions = () =>
			db.subscription.findMany({
				where: {
					userId: { in: [account.userId, secondaryAccount.userId] }
				},
				orderBy: { id: 'asc' }
			});
		const widgetsBefore = await widgetsSubscriptions();
		const checkout = async (user, session) => {
			const quote = await request('/crm/access/billing/quote', {
				token: session,
				body: {
					schemaVersion: 1,
					workspaceId: user.workspaceId,
					intent: 'CHECKOUT',
					cycle: 'MONTHLY',
					totalSeats: 2
				}
			});
			assert.equal(quote.workspaceId, user.workspaceId);
			const commandId = randomUUID();
			const body = {
				schemaVersion: 1,
				workspaceId: user.workspaceId,
				commandId,
				expectedBillingVersion: quote.billingVersion,
				expectedPolicyVersion: quote.priceSnapshot.policyVersion,
				cycle: 'MONTHLY',
				totalSeats: 2,
				autoRenew: false,
				consentVersion: null
			};
			const result = await request('/crm/access/billing/checkout', {
				token: session,
				body,
				commandId,
				status: 202
			});
			assert.ok(
				result.commandId === commandId &&
					result.state === 'PENDING' &&
					result.billing?.status === 'PENDING'
			);
			const orderId = result.billing.order.id;
			assert.match(orderId, UUID);
			const repeat = await request('/crm/access/billing/checkout', {
				token: session,
				body,
				commandId,
				status: 202
			});
			assert.equal(repeat.billing.order.id, orderId);
			return { orderId, commandId };
		};
		const happy = await checkout(account, token),
			revoked = await checkout(secondaryAccount, revokedToken);
		approvedOrders.add(happy.orderId);
		await changeSyntheticOwner(false);
		ownerRevoked = true;
		const firstOperation = await db.crmProviderOperation.findFirstOrThrow({
			where: { orderId: happy.orderId, kind: 'CREATE' }
		});
		const initialOutbox = await db.outboxEvent.findUniqueOrThrow({
			where: { id: firstOperation.outboxId }
		});
		assert.equal(initialOutbox.status, 'PENDING');
		advance('claim-duplicate-ambiguous');
		await pump(() => firstRequestWaiting);
		advance('concurrent-duplicate-claims');
		await Promise.all(
			[0, 1].map(() =>
				publisherRabbit.publish(
					'winwidget.events',
					EVENT,
					initialOutbox.payload,
					{ messageId: initialOutbox.eventId, type: EVENT }
				)
			)
		);
		await until(() => deliveryCounts.get(initialOutbox.eventId) >= 3);
		releaseFirstRequest();
		releaseFirstRequest = undefined;
		advance('same-key-transport-retry');
		await pump(async () => {
			const current = await db.crmOrder.findUniqueOrThrow({
				where: { id: happy.orderId }
			});
			return current.providerPaymentId && current.status === 'PENDING';
		});
		assert.equal(requests.size, 1);
		assert.equal(requests.get(happy.orderId).calls, 2);
		const retried = await db.crmProviderOperation.findUniqueOrThrow({
			where: { id: firstOperation.id }
		});
		assert.ok(
			retried.firstDispatchAt &&
				retried.dispatchAttempt === 2 &&
				retried.retryAttempt === 1
		);
		assert.equal(
			await db.crmPaidPeriod.count({
				where: { workspaceId: account.workspaceId }
			}),
			0
		);
		advance('fresh-owner-revocation');
		await pump(
			async () =>
				(
					await db.crmOrder.findUniqueOrThrow({
						where: { id: revoked.orderId }
					})
				).status === 'CANCELLED'
		);
		const denied = await db.crmProviderOperation.findFirstOrThrow({
			where: { orderId: revoked.orderId, kind: 'CREATE' }
		});
		assert.ok(
			denied.firstDispatchAt === null &&
				denied.dispatchAttempt === 0 &&
				denied.lastErrorCode === 'AUTHORIZATION_REVOKED'
		);
		assert.equal(
			await db.crmPaidPeriod.count({
				where: { workspaceId: secondaryAccount.workspaceId }
			}),
			0
		);
		assert.ok(reverseDenied >= 1 && reverseAllowed >= 2);
		await pump(
			async () =>
				(await inspectorChannel.checkQueue(MAIN + '.dead-letter'))
					.messageCount >= 1
		);
		await changeSyntheticOwner(true);
		ownerRevoked = false;
		advance('sales-disabled-provider-get-reconciliation');
		// API processes remain independently running; this disables new CREATE in
		// the actual worker/domain context while keeping its own queue configured.
		setEnvironment({ BILLING_WINCRM_PAYMENTS_ENABLED: 'false' });
		const before = await request(
			`/crm/access/billing/orders/${happy.orderId}?workspaceId=${account.workspaceId}`,
			{ token }
		);
		const context = await request(
			`/crm/access/billing?workspaceId=${account.workspaceId}`,
			{ token }
		);
		const verifyId = randomUUID();
		await request('/crm/access/billing/orders/verify', {
			token,
			commandId: verifyId,
			status: 202,
			body: {
				schemaVersion: 1,
				workspaceId: account.workspaceId,
				commandId: verifyId,
				expectedBillingVersion: context.billing.billingVersion,
				orderId: happy.orderId,
				expectedOrderVersion: before.order.version
			}
		});
		await pump(async () => {
			const current = await db.crmOrder.findUniqueOrThrow({
				where: { id: happy.orderId }
			});
			return (
				current.status === 'SUCCEEDED' &&
				(await db.crmPaymentReceipt.count({
					where: { orderId: happy.orderId, status: 'succeeded' }
				})) === 1
			);
		});
		assert.equal(
			requests.get(happy.orderId).calls,
			2,
			'Reconciliation cannot issue another CREATE'
		);
		assert.ok(providerGetCount >= 1 && providerReceiptCount >= 1);
		assert.equal(
			await db.crmPaidPeriod.count({
				where: { workspaceId: account.workspaceId, orderId: happy.orderId }
			}),
			1
		);
		const final = await request(
			`/crm/access/billing?workspaceId=${account.workspaceId}`,
			{ token }
		);
		assert.ok(
			final.billing.period?.orderId === happy.orderId &&
				final.billing.period.state === 'ACTIVE' &&
				final.capacity.pendingOperationId === null
		);
		assert.equal(final.billing.renewal.state, 'NONE');
		const proof = await request(
			`/crm/access/billing/operations/${happy.commandId}?workspaceId=${account.workspaceId}`,
			{ token }
		);
		assert.ok(
			proof.state === 'COMMITTED' &&
				proof.billing.releaseFence &&
				proof.billing.period.id === final.billing.period.id
		);
		advance('duplicate-after-settlement');
		await Promise.all(
			[0, 1].map(() =>
				publisherRabbit.publish(
					'winwidget.events',
					EVENT,
					initialOutbox.payload,
					{ messageId: initialOutbox.eventId, type: EVENT }
				)
			)
		);
		await pump(
			async () =>
				inflight.size === 0 &&
				(await inspectorChannel.checkQueue(MAIN)).messageCount === 0
		);
		assert.equal(
			await db.crmPaidPeriod.count({
				where: { workspaceId: account.workspaceId }
			}),
			1
		);
		assert.equal(
			await db.crmProviderDelivery.count({
				where: {
					eventId: initialOutbox.eventId,
					consumer: 'billing.wincrm-provider.v1'
				}
			}),
			1
		);
		assert.equal(
			(
				await db.outboxEvent.findUniqueOrThrow({
					where: { id: initialOutbox.id }
				})
			).status,
			'PUBLISHED'
		);
		assert.ok(sinkCount > 0 && !handlerFailure);
		assert.deepEqual(await widgetsSubscriptions(), widgetsBefore);
		const evidence = {
			schemaVersion: 1,
			workspaceId: account.workspaceId,
			orderId: happy.orderId,
			periodId: final.billing.period.id,
			publicCheckout: true,
			scopedRabbit: true,
			publisherDeniedConfigureAndRead: true,
			freshReverseAuthorization: true,
			claimBeforeHttp: true,
			concurrentDuplicates: true,
			sameKeyAmbiguousRetry: true,
			revokedBeforeDispatch: true,
			workerSalesOffGetReconciliation: true,
			syntheticReceipt: true,
			realProvider: false,
			trialScheduling: false,
			recurringCharge: false,
			malformedProviderResponse: false,
			widgetsSubscriptionsUnchanged: true,
			queues: [MAIN, MAIN + '.dead-letter', SINK]
		};
		log(
			'Billing real HTTP/Rabbit proof passed: checkout, duplicate delivery, ambiguous same-key retry, fresh owner revocation, sales-disabled GET/receipt reconciliation; synthetic provider only'
		);
		return evidence;
	} catch (error) {
		if (db) {
			const state = await bounded(
				db.crmProviderOperation.findMany({
					where: {
						workspaceId: {
							in: [account.workspaceId, secondaryAccount.workspaceId]
						}
					},
					select: {
						status: true,
						kind: true,
						dispatchAttempt: true,
						retryAttempt: true,
						lastErrorCode: true
					},
					take: 10
				}),
				3000
			).catch(() => []);
			const states = [
				'PENDING',
				'PROCESSING',
				'SUCCEEDED',
				'FAILED',
				'UNKNOWN'
			];
			const codes = [
				'TRANSPORT_UNKNOWN',
				'PROVIDER_RETRYABLE',
				'PROVIDER_REJECTED',
				'PROVIDER_INVALID_RESPONSE',
				'PROVIDER_BINDING_MISMATCH',
				'DEPENDENCY_UNAVAILABLE',
				'AUTHORIZATION_REVOKED',
				'LEASE_EXPIRED',
				'IDEMPOTENCY_WINDOW_EXPIRED'
			];
			log(
				`Billing HTTP proof safe state ${JSON.stringify({ reverseAllowed, reverseDenied, providerOrders: requests.size, operations: state.map(item => ({ state: states.includes(item.status) ? item.status : 'OTHER', kind: ['CREATE', 'VERIFY', 'SYNC_RECEIPT'].includes(item.kind) ? item.kind : 'OTHER', dispatchAttempt: item.dispatchAttempt, retryAttempt: item.retryAttempt, reason: codes.includes(item.lastErrorCode) ? item.lastErrorCode : null })) })}`
			);
		}
		const location =
			error instanceof Error
				? error.stack?.match(
						/wincrm-commerce-http-rabbit\.integration\.mjs:(\d+):\d+/
					)?.[1]
				: undefined;
		const http =
			error?.name === 'LocalHttpProofError' &&
			Number.isInteger(error.httpStatus)
				? ` http=${error.httpStatus} route=${error.route}`
				: '';
		throw new Error(
			`Billing HTTP/Rabbit proof failed phase=${phase}${location ? ` line=${location}` : ''}${http}; dependency details and values suppressed`
		);
	} finally {
		releaseFirstRequest?.();
		publisher?.onApplicationShutdown();
		worker?.onApplicationShutdown();
		// Cancel push delivery first; await the actual handlers before disconnecting
		// their database or removing the provider bridge. No abrupt Prisma shutdown.
		log(`Billing HTTP proof cleanup phase=${phase}`);
		await bounded(workerRabbit?.onApplicationShutdown()).catch(
			() => undefined
		);
		await bounded(Promise.allSettled([...inflight]), 25000).catch(
			() => undefined
		);
		await bounded(publisherRabbit?.onApplicationShutdown()).catch(
			() => undefined
		);
		if (sinkTag && inspectorChannel)
			await bounded(inspectorChannel.cancel(sinkTag)).catch(
				() => undefined
			);
		// Close a channel before its connection. Concurrent close handshakes on
		// the same AMQP socket can otherwise leave a channel promise unresolved.
		await bounded(aclProbe?.close()).catch(() => undefined);
		await bounded(inspectorChannel?.close()).catch(() => undefined);
		await bounded(inspector?.close()).catch(() => undefined);
		if (ownerRevoked)
			await bounded(changeSyntheticOwner(true)).catch(() => undefined);
		await bounded(db?.$disconnect()).catch(() => undefined);
		globalThis.fetch = originalFetch;
		if (providerServer) {
			providerServer.closeAllConnections();
			await bounded(
				new Promise(resolve => providerServer.close(resolve))
			).catch(() => undefined);
		}
		for (const [key, value] of previousEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		// Durable queues and all isolated databases belong to the harness inventory;
		// only the root's coordinated local cleanup removes them.
	}
}
