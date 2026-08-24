import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || '--integration';
const billingRequire = createRequire(
	join(serverRoot, 'apps/billing/package.json')
);

const sleep = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

const assertLoopbackUrl = (rawValue, name, protocols) => {
	assert.ok(rawValue, `${name} is required`);
	const url = new URL(rawValue);
	assert.ok(
		protocols.includes(url.protocol),
		`${name} protocol is invalid`
	);
	assert.ok(
		['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
			url.hostname.toLowerCase()
		),
		`${name} must use a loopback host`
	);
	for (const [key, value] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && value?.trim() === rawValue.trim()) {
			throw new Error(`${name} must not reuse ${key}`);
		}
	}
	return url;
};

const validateContract = async () => {
	assert.ok(
		['--self-test', '--integration'].includes(mode),
		'Usage: test-billing-runtime-boundaries.mjs [--self-test|--integration]'
	);
	const publisher = await readFile(
		join(
			serverRoot,
			'apps/billing/src/messaging/billing-outbox-publisher.service.ts'
		),
		'utf8'
	);
	const rabbit = await readFile(
		join(
			serverRoot,
			'apps/billing/src/messaging/billing-rabbitmq.service.ts'
		),
		'utf8'
	);
	const worker = await readFile(
		join(
			serverRoot,
			'apps/billing/src/messaging/billing-worker.service.ts'
		),
		'utf8'
	);
	const workflow = await readFile(
		join(serverRoot, '.github/workflows/deploy-production.yml'),
		'utf8'
	);
	for (const required of [
		'OutboxStatus.PROCESSING, leaseUntil: { lt: now }',
		'status: OutboxStatus.PUBLISHED',
		'leaseToken: event.leaseToken',
		'confirm: true',
		'mandatory: true',
		"channel.on('return'"
	]) {
		const source =
			required === 'confirm: true' ? rabbit : publisher + rabbit;
		assert.ok(
			source.includes(required),
			`Missing publisher boundary: ${required}`
		);
	}
	for (const required of [
		'status: DeliveryReceiptStatus.PROCESSING',
		'leaseUntil: { lte: now }',
		'eventId_consumer',
		"error as { code?: string }).code === 'P2002'"
	]) {
		assert.ok(
			worker.includes(required),
			`Missing receipt boundary: ${required}`
		);
	}
	for (const required of [
		'Create restricted Billing RabbitMQ users',
		'Billing PostgreSQL 18 monetary and RabbitMQ crash-boundary integration',
		"BILLING_RUNTIME_INTEGRATION_ALLOW_MUTATION: 'true'",
		'BILLING_TEST_RABBITMQ_WORKER_URL',
		'BILLING_TEST_RABBITMQ_PUBLISHER_URL',
		'winwidget-billing-worker',
		'winwidget-billing-publisher',
		'node scripts/test-billing-runtime-boundaries.mjs --integration',
		'postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296',
		'image: rabbitmq:4.2-management-alpine'
	]) {
		assert.ok(
			workflow.includes(required),
			`Missing CI boundary: ${required}`
		);
	}
};

const waitForMessage = async (channel, queue) => {
	for (let attempt = 1; attempt <= 100; attempt += 1) {
		const message = await channel.get(queue, { noAck: false });
		if (message) return message;
		await sleep(50);
	}
	throw new Error(
		'Timed out waiting for the Billing crash-recovery message'
	);
};

const runIntegration = async () => {
	const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
	const rabbitAdminUrl = process.env.BILLING_TEST_RABBITMQ_ADMIN_URL;
	const rabbitWorkerUrl = process.env.BILLING_TEST_RABBITMQ_WORKER_URL;
	const rabbitPublisherUrl =
		process.env.BILLING_TEST_RABBITMQ_PUBLISHER_URL;
	assert.equal(
		process.env.BILLING_RUNTIME_INTEGRATION_ALLOW_MUTATION,
		'true',
		'BILLING_RUNTIME_INTEGRATION_ALLOW_MUTATION=true is required'
	);
	const database = assertLoopbackUrl(
		databaseUrl,
		'BILLING_TEST_DATABASE_URL',
		['postgres:', 'postgresql:']
	);
	assert.match(
		decodeURIComponent(database.pathname.slice(1)),
		/(?:_ci|_test)$/,
		'Billing integration database name must end with _ci or _test'
	);
	const rabbitUrls = [
		[rabbitAdminUrl, 'BILLING_TEST_RABBITMQ_ADMIN_URL', 'winwidget'],
		[
			rabbitWorkerUrl,
			'BILLING_TEST_RABBITMQ_WORKER_URL',
			'winwidget-billing-worker'
		],
		[
			rabbitPublisherUrl,
			'BILLING_TEST_RABBITMQ_PUBLISHER_URL',
			'winwidget-billing-publisher'
		]
	].map(([raw, name, expectedUser]) => {
		const url = assertLoopbackUrl(raw, name, ['amqp:']);
		assert.equal(
			decodeURIComponent(url.pathname.replace(/^\//, '')),
			'winwidget',
			`${name} vhost must be winwidget`
		);
		assert.equal(decodeURIComponent(url.username), expectedUser);
		assert.ok(url.password, `${name} password is required`);
		return url;
	});
	assert.equal(new Set(rabbitUrls.map(url => url.username)).size, 3);
	assert.equal(new Set(rabbitUrls.map(url => url.password)).size, 3);
	const runId = process.env.BILLING_RUNTIME_INTEGRATION_RUN_ID || 'local';
	assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);

	process.env.BILLING_DATABASE_URL = databaseUrl;
	billingRequire('reflect-metadata');
	const {
		AffiliateReferralStatus,
		BillingPeriod,
		DeliveryReceiptStatus,
		OutboxStatus,
		PaymentKind,
		PaymentStatus,
		Plan,
		SubscriptionStatus
	} = billingRequire('@prisma/billing-client');
	const amqp = billingRequire('amqplib');
	const { BillingPrismaService } = billingRequire(
		join(
			serverRoot,
			'apps/billing/dist/src/prisma/billing-prisma.service.js'
		)
	);
	const { BillingRuntimeService } = billingRequire(
		join(
			serverRoot,
			'apps/billing/dist/src/runtime/billing-runtime.service.js'
		)
	);
	const { BillingRabbitMqService } = billingRequire(
		join(
			serverRoot,
			'apps/billing/dist/src/messaging/billing-rabbitmq.service.js'
		)
	);
	const { BillingOutboxPublisherService } = billingRequire(
		join(
			serverRoot,
			'apps/billing/dist/src/messaging/billing-outbox-publisher.service.js'
		)
	);
	const { BillingWorkerService } = billingRequire(
		join(
			serverRoot,
			'apps/billing/dist/src/messaging/billing-worker.service.js'
		)
	);
	const { PaymentDomainService } = billingRequire(
		join(
			serverRoot,
			'apps/billing/dist/src/domain/payment-domain.service.js'
		)
	);
	const { PaymentSuccessTransaction } = billingRequire(
		join(
			serverRoot,
			'apps/billing/dist/src/domain/payment-success.transaction.js'
		)
	);

	const prisma = new BillingPrismaService();
	let rabbitConnection;
	let channel;
	let publisherRabbit;
	let workerRabbit;
	const outboxIds = [];
	const receiptEventIds = [];
	const domainUserIds = [];
	const domainPaymentIds = [];
	const domainAggregateIds = [];
	let priorSettings = null;
	let settingsTouched = false;
	const queue = `winwidget.billing.ci.crash-boundary.${runId}`;
	try {
		await prisma.onModuleInit();
		const [databaseIdentity] = await prisma.$queryRawUnsafe(`
			SELECT
				current_setting('server_version_num')::integer / 10000 AS "major",
				current_setting('data_checksums') AS "checksums",
				current_user AS "role",
				has_schema_privilege(current_user, 'billing', 'CREATE') AS "schemaCreate",
				has_table_privilege(current_user, 'billing._prisma_migrations', 'SELECT') AS "migrationLedgerRead"
		`);
		assert.equal(databaseIdentity.major, 18);
		assert.equal(databaseIdentity.checksums, 'on');
		assert.equal(databaseIdentity.role, 'winwidget_billing_runtime');
		assert.equal(databaseIdentity.schemaCreate, false);
		assert.equal(databaseIdentity.migrationLedgerRead, false);

		const payerId = `ci-payer-${randomUUID()}`;
		const referrerId = `ci-referrer-${randomUUID()}`;
		const paymentId = `ci-payment-${randomUUID()}`;
		const affiliateId = `ci-affiliate-${randomUUID()}`;
		const providerPaymentId = `ci-provider-${randomUUID()}`;
		domainUserIds.push(payerId, referrerId);
		domainPaymentIds.push(paymentId);
		domainAggregateIds.push(paymentId, affiliateId);
		priorSettings = await prisma.billingSettings.findUnique({
			where: { id: 'singleton' }
		});
		await prisma.billingSettings.upsert({
			where: { id: 'singleton' },
			create: {
				id: 'singleton',
				affiliateProgramEnabled: true,
				affiliateCashbackPercent: 10
			},
			update: {
				affiliateProgramEnabled: true,
				affiliateCashbackPercent: 10
			}
		});
		settingsTouched = true;
		await prisma.identityContactProjection.createMany({
			data: [
				{
					userId: payerId,
					name: 'Billing CI payer',
					email: 'payer@example.test',
					status: 'ACTIVE',
					roles: ['USER'],
					projectionVersion: 1n,
					sourceSequence: 1n
				},
				{
					userId: referrerId,
					name: 'Billing CI referrer',
					email: 'referrer@example.test',
					status: 'ACTIVE',
					roles: ['USER'],
					projectionVersion: 1n,
					sourceSequence: 1n
				}
			]
		});
		await prisma.affiliateReferral.create({
			data: {
				id: affiliateId,
				referrerId,
				referredUserId: payerId,
				status: AffiliateReferralStatus.REGISTERED,
				aggregateVersion: 1n,
				sourceSequence: 1n
			}
		});
		const now = new Date();
		await prisma.payment.create({
			data: {
				id: paymentId,
				userId: payerId,
				kind: PaymentKind.ONE_TIME,
				amount: '990.00',
				currency: 'RUB',
				status: PaymentStatus.CANCELLED,
				providerStatus: 'canceled',
				plan: Plan.EASY,
				billingPeriod: BillingPeriod.MONTHLY,
				autoRenew: true,
				consentVersion: 'auto-renewal-2026-07-28-v4',
				consentText: 'ci-consent',
				consentedAt: now,
				offerSnapshot: 'ci-offer',
				offerSha256:
					'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
				offerUpdatedAt: now,
				checkoutExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
				cancelledAt: now,
				cancellationReason: 'user_cancelled',
				aggregateVersion: 1n,
				sourceSequence: 1n
			}
		});
		const success = new PaymentSuccessTransaction(prisma);
		const successInput = {
			paymentId,
			providerPaymentId,
			providerAmount: '990.00',
			providerCurrency: 'RUB',
			succeededAt: now,
			paymentMethodCiphertext: 'ci-saved-method',
			paymentMethodType: 'bank_card',
			paymentMethodTitle: 'CI card',
			paymentMethodLast4: '4242',
			providerSnapshot: {
				id: providerPaymentId,
				status: 'succeeded',
				metadata: { paymentId }
			}
		};
		const successResults = await Promise.all([
			success.apply(successInput),
			success.apply(successInput)
		]);
		assert.equal(
			successResults.filter(result => result.duplicate === false).length,
			1
		);
		assert.equal(
			successResults.filter(result => result.duplicate === true).length,
			1
		);
		const [succeededPayment, subscription, affiliate, renewal] =
			await Promise.all([
				prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
				prisma.subscription.findUniqueOrThrow({
					where: { userId: payerId }
				}),
				prisma.affiliateReferral.findUniqueOrThrow({
					where: { id: affiliateId }
				}),
				prisma.autoRenewal.findUnique({ where: { userId: payerId } })
			]);
		domainAggregateIds.push(subscription.id);
		assert.equal(succeededPayment.status, PaymentStatus.SUCCEEDED);
		assert.equal(succeededPayment.yookassaId, providerPaymentId);
		assert.equal(subscription.status, SubscriptionStatus.ACTIVE);
		assert.equal(affiliate.status, AffiliateReferralStatus.REWARD_PENDING);
		assert.equal(affiliate.firstPaymentId, paymentId);
		assert.equal(affiliate.cashbackAmount, 99);
		assert.equal(
			renewal,
			null,
			'a locally closed checkout must not restore auto-renewal consent'
		);
		assert.equal(
			await prisma.outboxEvent.count({
				where: {
					eventType: 'payment.succeeded.v1',
					aggregateId: paymentId
				}
			}),
			1
		);
		const paymentSucceededOutbox =
			await prisma.outboxEvent.findFirstOrThrow({
				where: {
					eventType: 'payment.succeeded.v1',
					aggregateId: paymentId
				}
			});

		const paymentDomain = new PaymentDomainService(prisma, {});
		const duplicateWebhook = {
			event: 'payment.succeeded',
			object: {
				id: providerPaymentId,
				metadata: { paymentId }
			}
		};
		await Promise.all([
			paymentDomain.webhook(duplicateWebhook),
			paymentDomain.webhook(duplicateWebhook)
		]);
		assert.equal(
			await prisma.providerOperation.count({
				where: {
					idempotencyKey: `webhook:payment.succeeded:${providerPaymentId}`
				}
			}),
			1
		);
		// The guard above requires a dedicated *_ci/*_test database. Keep the real
		// payment event so the crash-recovery probe exercises a production-allowed
		// routing key and payload, while removing unrelated monetary events and
		// residues left by an intentionally interrupted previous rehearsal.
		await prisma.outboxEvent.deleteMany({
			where: { id: { not: paymentSucceededOutbox.id } }
		});

		rabbitConnection = await amqp.connect(rabbitAdminUrl, {
			clientProperties: {
				connection_name: `winwidget-billing-ci-probe-${runId}`
			}
		});
		channel = await rabbitConnection.createConfirmChannel();
		await channel.assertExchange('winwidget.events', 'topic', {
			durable: true
		});
		await channel.assertQueue(queue, {
			autoDelete: true,
			durable: false,
			exclusive: true
		});
		await channel.bindQueue(
			queue,
			'winwidget.events',
			'payment.succeeded.v1'
		);
		const workerConfigValues = {
			BILLING_PROCESS_ROLE: 'worker',
			RABBITMQ_URL: rabbitWorkerUrl,
			RABBITMQ_CONNECTION_NAME: 'winwidget-billing-worker',
			RABBITMQ_ASSERT_TOPOLOGY: 'true'
		};
		const workerConfig = { get: key => workerConfigValues[key] };
		const workerRuntime = new BillingRuntimeService(workerConfig);
		workerRabbit = new BillingRabbitMqService(workerConfig, workerRuntime);
		await workerRabbit.onModuleInit();
		assert.equal(workerRabbit.isConnected(), true);
		assert.equal(workerRabbit.isTopologyReady(), true);
		for (const requiredQueue of [
			'winwidget.billing.identity.v1',
			'winwidget.billing.offer.v2',
			'winwidget.billing.lifecycle-repair.v1',
			'winwidget.payment.auto-renewal',
			'winwidget.billing.notification-delivery-outcome'
		]) {
			await channel.checkQueue(requiredQueue);
			for (const suffix of [
				'.retry.1',
				'.retry.2',
				'.retry.3',
				'.dead-letter'
			]) {
				await channel.checkQueue(`${requiredQueue}${suffix}`);
			}
		}

		const configValues = {
			BILLING_PROCESS_ROLE: 'outbox-publisher',
			BILLING_OUTBOX_BATCH_SIZE: '1',
			BILLING_OUTBOX_POLL_INTERVAL_MS: '60000',
			RABBITMQ_URL: rabbitPublisherUrl,
			RABBITMQ_CONNECTION_NAME: 'winwidget-billing-outbox-publisher',
			RABBITMQ_ASSERT_TOPOLOGY: 'false'
		};
		const config = { get: key => configValues[key] };
		const runtime = new BillingRuntimeService(config);
		publisherRabbit = new BillingRabbitMqService(config, runtime);
		await publisherRabbit.onModuleInit();
		assert.equal(publisherRabbit.isConnected(), true);
		assert.equal(publisherRabbit.isTopologyReady(), true);
		const publisher = new BillingOutboxPublisherService(
			prisma,
			runtime,
			publisherRabbit
		);

		const recoveredEventId = paymentSucceededOutbox.eventId;
		const recoveredOutboxId = paymentSucceededOutbox.id;
		outboxIds.push(recoveredOutboxId);
		await prisma.outboxEvent.update({
			where: { id: recoveredOutboxId },
			data: {
				status: OutboxStatus.PROCESSING,
				attempt: 1,
				availableAt: new Date(Date.now() - 60_000),
				leaseToken: randomUUID(),
				leaseUntil: new Date(Date.now() - 1_000),
				publishedAt: null,
				lastError: null
			}
		});
		assert.equal(await publisher.publishOne(), true);
		const recovered = await prisma.outboxEvent.findUniqueOrThrow({
			where: { id: recoveredOutboxId }
		});
		assert.equal(recovered.status, OutboxStatus.PUBLISHED);
		assert.equal(recovered.attempt, 2);
		assert.equal(recovered.leaseToken, null);
		assert.equal(recovered.leaseUntil, null);
		assert.ok(recovered.publishedAt instanceof Date);
		const delivered = await waitForMessage(channel, queue);
		assert.equal(delivered.properties.messageId, recoveredEventId);
		assert.equal(delivered.properties.type, 'payment.succeeded.v1');
		assert.equal(delivered.fields.redelivered, false);
		channel.ack(delivered);
		assert.equal(await publisher.publishOne(), false);

		for (const route of [
			{
				exchange: 'winwidget.billing.retry',
				routingKey: 'trial-request.retry.1',
				queue: 'winwidget.billing.trial.v1.retry.1',
				prefix: 'retry'
			},
			{
				exchange: 'winwidget.billing.dead-letter',
				routingKey: 'trial-request.dead-letter',
				queue: 'winwidget.billing.trial.v1.dead-letter',
				prefix: 'dead-letter'
			}
		]) {
			const eventId = randomUUID();
			const outboxId = `ci-${route.prefix}-${randomUUID()}`;
			outboxIds.push(outboxId);
			await prisma.outboxEvent.create({
				data: {
					id: outboxId,
					eventId,
					eventType: 'billing.trial.requested.v1',
					aggregateType: 'billing.trial',
					aggregateId: outboxId,
					exchange: route.exchange,
					routingKey: route.routingKey,
					payload: {
						schemaVersion: 1,
						eventType: 'billing.trial.requested.v1',
						eventId,
						rehearsal: true
					},
					availableAt: new Date(Date.now() - 1_000)
				}
			});
			assert.equal(await publisher.publishOne(), true);
			assert.equal(
				(
					await prisma.outboxEvent.findUniqueOrThrow({
						where: { id: outboxId }
					})
				).status,
				OutboxStatus.PUBLISHED
			);
			const routed = await waitForMessage(channel, route.queue);
			assert.equal(routed.properties.messageId, eventId);
			channel.ack(routed);
		}
		assert.equal(await publisher.publishOne(), false);

		const returnedEventId = randomUUID();
		const returnedOutboxId = `ci-return-${randomUUID()}`;
		outboxIds.push(returnedOutboxId);
		await prisma.outboxEvent.create({
			data: {
				id: returnedOutboxId,
				eventId: returnedEventId,
				eventType: 'admin.audit.event.v1',
				aggregateType: 'billing.ci',
				aggregateId: returnedOutboxId,
				exchange: 'winwidget.events',
				routingKey: 'admin.audit.billing.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'admin.audit.event.v1',
					eventId: returnedEventId
				},
				availableAt: new Date(Date.now() - 1_000)
			}
		});
		assert.equal(await publisher.publishOne(), true);
		const returned = await prisma.outboxEvent.findUniqueOrThrow({
			where: { id: returnedOutboxId }
		});
		assert.equal(returned.status, OutboxStatus.PENDING);
		assert.equal(returned.leaseToken, null);
		assert.equal(returned.leaseUntil, null);
		assert.match(returned.lastError || '', /mandatory publication/i);

		const receiptEventId = randomUUID();
		receiptEventIds.push(receiptEventId);
		await prisma.integrationDeliveryReceipt.create({
			data: {
				eventId: receiptEventId,
				consumer: 'ci-crash-recovery',
				status: DeliveryReceiptStatus.PROCESSING,
				lockedAt: new Date(Date.now() - 120_000),
				leaseUntil: new Date(Date.now() - 1_000),
				claimToken: randomUUID(),
				attempt: 1
			}
		});
		const worker = new BillingWorkerService(
			prisma,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		);
		const claims = await Promise.all([
			worker.claimReceipt(receiptEventId, 'ci-crash-recovery'),
			worker.claimReceipt(receiptEventId, 'ci-crash-recovery')
		]);
		const successfulClaims = claims.filter(Boolean);
		assert.equal(successfulClaims.length, 1);
		const receipt =
			await prisma.integrationDeliveryReceipt.findUniqueOrThrow({
				where: {
					eventId_consumer: {
						eventId: receiptEventId,
						consumer: 'ci-crash-recovery'
					}
				}
			});
		assert.equal(receipt.status, DeliveryReceiptStatus.PROCESSING);
		assert.equal(receipt.claimToken, successfulClaims[0]);
		assert.equal(receipt.attempt, 2);
		assert.ok(receipt.leaseUntil > new Date());
		await prisma.integrationDeliveryReceipt.updateMany({
			where: {
				eventId: receiptEventId,
				consumer: 'ci-crash-recovery',
				claimToken: successfulClaims[0]
			},
			data: {
				status: DeliveryReceiptStatus.DELIVERED,
				deliveredAt: new Date(),
				claimToken: null,
				leaseUntil: null
			}
		});
		assert.equal(
			await worker.claimReceipt(receiptEventId, 'ci-crash-recovery'),
			null
		);
	} finally {
		if (domainAggregateIds.length) {
			await prisma.outboxEvent
				.deleteMany({ where: { aggregateId: { in: domainAggregateIds } } })
				.catch(() => undefined);
		}
		if (domainPaymentIds.length) {
			await prisma.providerOperation
				.deleteMany({ where: { paymentId: { in: domainPaymentIds } } })
				.catch(() => undefined);
			await prisma.paymentReceipt
				.deleteMany({ where: { paymentId: { in: domainPaymentIds } } })
				.catch(() => undefined);
		}
		if (domainUserIds.length) {
			await prisma.affiliateReferral
				.deleteMany({
					where: {
						OR: [
							{ referrerId: { in: domainUserIds } },
							{ referredUserId: { in: domainUserIds } }
						]
					}
				})
				.catch(() => undefined);
			await prisma.autoRenewal
				.deleteMany({ where: { userId: { in: domainUserIds } } })
				.catch(() => undefined);
			await prisma.subscription
				.deleteMany({ where: { userId: { in: domainUserIds } } })
				.catch(() => undefined);
			await prisma.payment
				.deleteMany({ where: { id: { in: domainPaymentIds } } })
				.catch(() => undefined);
			await prisma.identityContactProjection
				.deleteMany({ where: { userId: { in: domainUserIds } } })
				.catch(() => undefined);
		}
		if (settingsTouched) {
			if (priorSettings) {
				await prisma.billingSettings
					.update({
						where: { id: 'singleton' },
						data: {
							paymentEnabled: priorSettings.paymentEnabled,
							autoRenewalSignupEnabled:
								priorSettings.autoRenewalSignupEnabled,
							autoRenewalChargesEnabled:
								priorSettings.autoRenewalChargesEnabled,
							autoRenewalChargesEnabledAt:
								priorSettings.autoRenewalChargesEnabledAt,
							affiliateProgramEnabled:
								priorSettings.affiliateProgramEnabled,
							affiliateCashbackPercent:
								priorSettings.affiliateCashbackPercent,
							consentVersion: priorSettings.consentVersion,
							consentText: priorSettings.consentText,
							offerSectionHash: priorSettings.offerSectionHash,
							offerSnapshot: priorSettings.offerSnapshot,
							offerUpdatedAt: priorSettings.offerUpdatedAt,
							paymentNotificationDestination:
								priorSettings.paymentNotificationDestination,
							aggregateVersion: priorSettings.aggregateVersion,
							sourceSequence: priorSettings.sourceSequence
						}
					})
					.catch(() => undefined);
			} else {
				await prisma.billingSettings
					.delete({ where: { id: 'singleton' } })
					.catch(() => undefined);
			}
		}
		if (receiptEventIds.length) {
			await prisma.integrationDeliveryReceipt
				.deleteMany({ where: { eventId: { in: receiptEventIds } } })
				.catch(() => undefined);
		}
		if (outboxIds.length) {
			await prisma.outboxEvent
				.deleteMany({ where: { id: { in: outboxIds } } })
				.catch(() => undefined);
		}
		await publisherRabbit?.onApplicationShutdown().catch(() => undefined);
		await workerRabbit?.onApplicationShutdown().catch(() => undefined);
		await channel?.deleteQueue(queue).catch(() => undefined);
		await channel?.close().catch(() => undefined);
		await rabbitConnection?.close().catch(() => undefined);
		await prisma.disconnect().catch(() => undefined);
	}
};

await validateContract();
if (mode === '--integration') await runIntegration();
process.stdout.write(
	`billing_runtime_boundaries=${mode === '--self-test' ? 'self-test-' : ''}passed\n`
);
