import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	CORE_OWNED_MESSAGING_KINDS,
	getMessagingQueueHealthExpectations,
	OUTBOX_LOCK_TIMEOUT_MS
} from '@/messaging/messaging.constants';
import {
	BillingMessagingClientService,
	BillingMessagingOverview
} from '@/messaging/billing-messaging-client.service';
import {
	NotificationDeliveryClientService,
	NotificationDeliveryOverview
} from '@/messaging/notification-delivery-client.service';
import { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import {
	WidgetsDeliveryFailuresClientService,
	WidgetsMessagingOverview
} from '@/messaging/widgets-delivery-failures-client.service';
import { PrismaService } from '@/prisma.service';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

type HealthStatus = 'ok' | 'warning' | 'down' | 'disabled';

type HealthCheck = {
	id: string;
	title: string;
	status: HealthStatus;
	message: string;
	latencyMs?: number;
};

type NotificationDeliveryResult = {
	overview: NotificationDeliveryOverview | null;
	error: string | null;
};

type WidgetsOverviewResult = {
	overview: WidgetsMessagingOverview | null;
	error: string | null;
};

type BillingOverviewResult = {
	billingOwner: boolean | null;
	overview: BillingMessagingOverview | null;
	error: string | null;
};

const getRabbitQueueDepth = (queue: {
	messages: number;
	messages_ready: number;
	messages_unacknowledged: number;
}): number =>
	Math.max(
		queue.messages,
		queue.messages_ready + queue.messages_unacknowledged
	);

@Injectable()
export class HealthService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly configService: ConfigService,
		private readonly rabbitManagement: RabbitMqManagementService,
		private readonly notificationDelivery: NotificationDeliveryClientService,
		private readonly widgets: WidgetsDeliveryFailuresClientService,
		private readonly billingState: BillingCoreStateService,
		private readonly billing: BillingMessagingClientService
	) {}

	async getAdminHealth() {
		const notificationDeliveryResult =
			this.getNotificationDeliveryResult();
		const widgetsResult = this.getWidgetsResult();
		const billingResult = this.getBillingResult();
		const checks = await Promise.all([
			this.checkBackend(),
			this.checkDatabase(),
			this.checkRabbitMq(),
			this.checkNotificationDelivery(notificationDeliveryResult),
			this.checkWidgets(widgetsResult),
			this.checkBilling(billingResult),
			this.checkMessagingHeartbeat('outbox-publisher', 'Outbox publisher'),
			this.checkMessagingHeartbeat(
				'integration-worker',
				'Integration worker'
			),
			this.checkMessagingHeartbeat(
				'maintenance-worker',
				'Maintenance worker'
			),
			this.checkMessagingBacklog(
				notificationDeliveryResult,
				widgetsResult,
				billingResult
			),
			this.checkScheduledJobs(),
			this.checkS3(),
			this.checkSmtp(),
			this.checkSmsAero(),
			this.checkRecaptcha(),
			this.checkYooKassa(billingResult),
			this.checkInfoTelegramBot(),
			this.checkSupportTelegramBot()
		]);

		return {
			generatedAt: new Date().toISOString(),
			mode: this.configService.get<string>('MODE') || 'development',
			uptimeSeconds: Math.round(process.uptime()),
			checks
		};
	}

	getLivenessHealth() {
		return {
			status: 'ok',
			service: 'api',
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	async getReadinessHealth() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
		} catch {
			throw new ServiceUnavailableException('Database is not ready');
		}
		return {
			status: 'ready',
			service: 'api',
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	private async checkBackend(): Promise<HealthCheck> {
		return {
			id: 'backend',
			title: 'Бекенд',
			status: 'ok',
			message: 'API отвечает'
		};
	}

	private async checkDatabase(): Promise<HealthCheck> {
		return this.measure('database', 'База данных', async () => {
			await this.prisma.$queryRaw`SELECT 1`;
			return 'Подключение к базе работает';
		});
	}

	private async checkRabbitMq(): Promise<HealthCheck> {
		const startedAt = Date.now();
		try {
			const [version, broker, queues, billingOwner] = await Promise.all([
				this.rabbitManagement.checkConnection(),
				this.rabbitManagement.getBrokerHealth(),
				this.rabbitManagement.getMessagingQueues(),
				this.billingState.isBillingOwner()
			]);
			const queueExpectations = getMessagingQueueHealthExpectations({
				billingOwner
			});
			const requiredQueues = queueExpectations.map(
				expectation => expectation.name
			);
			const queuesByName = new Map(
				queues.map(queue => [queue.name, queue])
			);
			const missing = requiredQueues.filter(
				queue => !queuesByName.has(queue)
			);
			const consumerless = queueExpectations
				.filter(
					expectation => expectation.consumerExpectation === 'at-least-one'
				)
				.filter(
					expectation =>
						(queuesByName.get(expectation.name)?.consumers ?? 1) < 1
				)
				.map(expectation => expectation.name);
			const unexpectedlyConsumed = queueExpectations
				.filter(expectation => expectation.consumerExpectation === 'none')
				.filter(
					expectation =>
						(queuesByName.get(expectation.name)?.consumers ?? 0) > 0
				)
				.map(expectation => expectation.name);
			const nonemptyPassiveQueues = queueExpectations
				.filter(expectation => expectation.alertOnAnyMessage)
				.filter(expectation => {
					const queue = queuesByName.get(expectation.name);
					return queue && getRabbitQueueDepth(queue) > 0;
				})
				.map(expectation => expectation.name);
			const alarms = [
				...broker.alarmNodes,
				...broker.stoppedNodes,
				...broker.partitionedNodes
			];
			const hasProblem =
				!broker.nodes.length ||
				missing.length > 0 ||
				consumerless.length > 0 ||
				unexpectedlyConsumed.length > 0 ||
				nonemptyPassiveQueues.length > 0 ||
				alarms.length > 0;
			return {
				id: 'rabbitmq',
				title: 'RabbitMQ',
				status: hasProblem ? 'warning' : 'ok',
				message: hasProblem
					? `${version}; отсутствуют очереди: ${missing.length}, без обязательных consumers: ${consumerless.length}, неожиданные consumers: ${unexpectedlyConsumed.length}, пассивные DLQ с сообщениями: ${nonemptyPassiveQueues.length}, alarms/nodes: ${alarms.length + (broker.nodes.length ? 0 : 1)}`
					: `${version}; ${requiredQueues.length} обязательных очередей готовы`,
				latencyMs: Date.now() - startedAt
			};
		} catch (error) {
			return {
				id: 'rabbitmq',
				title: 'RabbitMQ',
				status: 'down',
				message: error instanceof Error ? error.message : String(error),
				latencyMs: Date.now() - startedAt
			};
		}
	}

	private async checkMessagingHeartbeat(
		service: string,
		title: string
	): Promise<HealthCheck> {
		const latest = await this.prisma.messagingHeartbeat.findFirst({
			where: { service },
			orderBy: { lastSeenAt: 'desc' },
			select: { lastSeenAt: true }
		});
		const ageMs = latest ? Date.now() - latest.lastSeenAt.getTime() : null;
		const healthy = ageMs !== null && ageMs <= 30_000;

		return {
			id: service.replace('-', '_'),
			title,
			status: healthy ? 'ok' : 'down',
			message: healthy
				? `Heartbeat получен ${Math.round(ageMs / 1000)} сек. назад`
				: latest
					? `Heartbeat не поступал ${Math.round((ageMs || 0) / 1000)} сек.`
					: 'Heartbeat ещё не зарегистрирован'
		};
	}

	private async checkNotificationDelivery(
		resultPromise: Promise<NotificationDeliveryResult>
	): Promise<HealthCheck> {
		const startedAt = Date.now();
		const result = await resultPromise;
		if (!result.overview || result.error) {
			return {
				id: 'notification_delivery',
				title: 'Notification Delivery',
				status: 'down',
				message: result.error || 'Internal API вернул пустой ответ',
				latencyMs: Date.now() - startedAt
			};
		}

		const heartbeatAt = this.parseDate(
			result.overview.heartbeat.lastSeenAt
		);
		const heartbeatAgeMs = heartbeatAt
			? Date.now() - heartbeatAt.getTime()
			: null;
		const heartbeatFresh =
			result.overview.heartbeat.status === 'ok' &&
			heartbeatAgeMs !== null &&
			heartbeatAgeMs <= 30_000;
		const publishAt = this.parseDate(
			result.overview.heartbeat.lastSuccessfulPublishAt
		);
		const publishStale =
			result.overview.operational.dueOutbox > 0 &&
			(!publishAt ||
				Date.now() - publishAt.getTime() > this.getActivityStaleMs());
		const status: HealthStatus = !heartbeatFresh
			? 'down'
			: publishStale
				? 'warning'
				: 'ok';
		const heartbeatDescription =
			heartbeatAgeMs === null
				? 'heartbeat отсутствует'
				: `heartbeat ${Math.max(0, Math.round(heartbeatAgeMs / 1000))} сек. назад`;
		const activityDescription = publishStale
			? `publisher activity зависла при ${result.overview.operational.dueOutbox} готовых событиях`
			: `активных instances: ${result.overview.heartbeat.activeInstances}`;

		return {
			id: 'notification_delivery',
			title: 'Notification Delivery',
			status,
			message: `${heartbeatDescription}; ${activityDescription}`,
			latencyMs: Date.now() - startedAt
		};
	}

	private async checkMessagingBacklog(
		resultPromise: Promise<NotificationDeliveryResult>,
		widgetsResultPromise: Promise<WidgetsOverviewResult>,
		billingResultPromise: Promise<BillingOverviewResult> = this.getBillingResult()
	): Promise<HealthCheck> {
		const billing = await billingResultPromise;
		const now = new Date();
		const expiredPublishingBefore = new Date(
			now.getTime() - OUTBOX_LOCK_TIMEOUT_MS
		);
		const [
			failedOutbox,
			unresolvedFailures,
			oldestDuePending,
			oldestExpiredPublishing,
			notificationDelivery,
			widgets
		] = await Promise.all([
			this.prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
			this.prisma.integrationDeliveryFailure.count({
				where: {
					resolvedAt: null,
					integration: {
						in: [...CORE_OWNED_MESSAGING_KINDS]
					}
				}
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: 'PENDING',
					availableAt: { lte: now }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: 'PUBLISHING',
					lockedAt: { lte: expiredPublishingBefore }
				},
				orderBy: { lockedAt: 'asc' },
				select: { lockedAt: true }
			}),
			resultPromise,
			widgetsResultPromise
		]);
		const oldestPendingAt = [
			oldestDuePending?.availableAt || null,
			oldestExpiredPublishing?.lockedAt
				? new Date(
						oldestExpiredPublishing.lockedAt.getTime() +
							OUTBOX_LOCK_TIMEOUT_MS
					)
				: null,
			this.parseDate(
				notificationDelivery.overview?.oldestPendingAt || null
			),
			this.parseDate(widgets.overview?.oldestPendingAt || null),
			this.parseDate(billing.overview?.oldestPendingAt || null)
		]
			.filter((value): value is Date => Boolean(value))
			.sort((left, right) => left.getTime() - right.getTime())[0];
		const oldestAgeSeconds = oldestPendingAt
			? Math.max(
					0,
					Math.round((Date.now() - oldestPendingAt.getTime()) / 1000)
				)
			: 0;
		const combinedFailedOutbox =
			failedOutbox +
			(notificationDelivery.overview?.outbox.FAILED || 0) +
			(widgets.overview?.outbox.FAILED || 0);
		const combinedUnresolvedFailures =
			unresolvedFailures +
			(notificationDelivery.overview?.unresolvedFailures || 0) +
			(widgets.overview?.unresolvedFailures || 0) +
			(billing.overview?.unresolvedFailures || 0);
		const hasProblem =
			combinedFailedOutbox > 0 ||
			combinedUnresolvedFailures > 0 ||
			oldestAgeSeconds > 60 ||
			Boolean(notificationDelivery.error) ||
			Boolean(widgets.error) ||
			Boolean(billing.error);
		const unavailable = [
			notificationDelivery.error
				? `Notification Delivery metrics недоступны: ${notificationDelivery.error}`
				: '',
			widgets.error ? `Widgets metrics недоступны: ${widgets.error}` : '',
			billing.error ? `Billing metrics недоступны: ${billing.error}` : ''
		]
			.filter(Boolean)
			.join('; ');

		return {
			id: 'messaging_backlog',
			title: 'Очередь интеграций',
			status: hasProblem ? 'warning' : 'ok',
			message: hasProblem
				? `Outbox FAILED: ${combinedFailedOutbox}, DLQ: ${combinedUnresolvedFailures}, старейшее ожидание: ${oldestAgeSeconds} сек.${unavailable ? `; ${unavailable}` : ''}`
				: 'Задержек и необработанных ошибок нет'
		};
	}

	private async checkWidgets(
		resultPromise: Promise<WidgetsOverviewResult>
	): Promise<HealthCheck> {
		const startedAt = Date.now();
		const result = await resultPromise;
		if (!result.overview || result.error) {
			return {
				id: 'widgets',
				title: 'Widgets',
				status: 'down',
				message: result.error || 'Internal API вернул пустой ответ',
				latencyMs: Date.now() - startedAt
			};
		}

		const down = result.overview.heartbeats.filter(
			heartbeat => heartbeat.status === 'down'
		);
		const publisher = result.overview.heartbeats.find(
			heartbeat => heartbeat.service === 'widgets-publisher'
		);
		const publishAt = this.parseDate(publisher?.lastSuccessfulPublishAt);
		const publishStale =
			result.overview.operational.dueOutbox > 0 &&
			(!publishAt ||
				Date.now() - publishAt.getTime() > this.getActivityStaleMs());
		return {
			id: 'widgets',
			title: 'Widgets',
			status: down.length ? 'down' : publishStale ? 'warning' : 'ok',
			message: down.length
				? `Нет heartbeat: ${down.map(item => item.service).join(', ')}`
				: publishStale
					? `Publisher activity зависла при ${result.overview.operational.dueOutbox} готовых событиях`
					: 'API, worker и publisher активны',
			latencyMs: Date.now() - startedAt
		};
	}

	private async checkBilling(
		resultPromise: Promise<BillingOverviewResult>
	): Promise<HealthCheck> {
		const startedAt = Date.now();
		const result = await resultPromise;
		if (result.billingOwner === false) {
			return {
				id: 'billing',
				title: 'Billing',
				status: 'disabled',
				message: 'До cutover владельцем Billing остаётся Core',
				latencyMs: Date.now() - startedAt
			};
		}
		if (!result.overview || result.error) {
			return {
				id: 'billing',
				title: 'Billing',
				status: 'down',
				message: result.error || 'Internal API вернул пустой ответ',
				latencyMs: Date.now() - startedAt
			};
		}
		const heartbeats = result.overview.heartbeats || [];
		const down = heartbeats.filter(
			heartbeat => heartbeat.status === 'down'
		);
		const missing = heartbeats.length !== 4;
		const revisions = new Set(
			heartbeats
				.map(heartbeat => heartbeat.revision)
				.filter((revision): revision is string => Boolean(revision))
		);
		const revisionMismatch =
			!missing && !down.length && revisions.size !== 1;
		return {
			id: 'billing',
			title: 'Billing',
			status:
				missing || down.length
					? 'down'
					: revisionMismatch
						? 'warning'
						: 'ok',
			message: missing
				? 'Billing не опубликовал readiness всех процессов'
				: down.length
					? `Не готовы процессы: ${down.map(item => item.service).join(', ')}`
					: revisionMismatch
						? 'Процессы Billing запущены на разных revisions'
						: 'API, scheduler, worker и outbox publisher готовы',
			latencyMs: Date.now() - startedAt
		};
	}

	private getNotificationDeliveryResult(): Promise<NotificationDeliveryResult> {
		return this.notificationDelivery
			.getOverview()
			.then(overview => ({ overview, error: null }))
			.catch(error => ({
				overview: null,
				error:
					error instanceof Error
						? error.message
						: 'Notification Delivery недоступен'
			}));
	}

	private getWidgetsResult(): Promise<WidgetsOverviewResult> {
		return this.widgets
			.getOverview()
			.then(overview => ({ overview, error: null }))
			.catch(error => ({
				overview: null,
				error:
					error instanceof Error ? error.message : 'Widgets недоступен'
			}));
	}

	private async getBillingResult(): Promise<BillingOverviewResult> {
		try {
			const billingOwner = await this.billingState.isBillingOwner();
			if (!billingOwner) {
				return { billingOwner: false, overview: null, error: null };
			}
			try {
				return {
					billingOwner: true,
					overview: await this.billing.getOverview(),
					error: null
				};
			} catch (error) {
				return {
					billingOwner: true,
					overview: null,
					error:
						error instanceof Error ? error.message : 'Billing недоступен'
				};
			}
		} catch (error) {
			return {
				billingOwner: null,
				overview: null,
				error:
					error instanceof Error
						? error.message
						: 'Billing ownership недоступен'
			};
		}
	}

	private parseDate(value?: string | null): Date | null {
		if (!value) return null;
		const timestamp = Date.parse(value);
		return Number.isFinite(timestamp) ? new Date(timestamp) : null;
	}

	private getActivityStaleMs(): number {
		const configured = Number(
			this.configService.get<string>('MESSAGING_ACTIVITY_STALE_MS') ||
				5 * 60 * 1000
		);
		return Number.isInteger(configured) && configured >= 30_000
			? Math.min(configured, 24 * 60 * 60 * 1000)
			: 5 * 60 * 1000;
	}

	private async checkScheduledJobs(): Promise<HealthCheck> {
		const now = new Date();
		const overdueBefore = new Date(now.getTime() - 15 * 60 * 1000);
		const [failed, overdueQueued, expiredLeases] = await Promise.all([
			this.prisma.scheduledJobRun.count({
				where: { status: 'FAILED' }
			}),
			this.prisma.scheduledJobRun.count({
				where: {
					status: 'QUEUED',
					availableAt: { lt: overdueBefore }
				}
			}),
			this.prisma.scheduledJobRun.count({
				where: {
					status: 'PROCESSING',
					leaseExpiresAt: { lt: now }
				}
			})
		]);
		const hasProblem =
			failed > 0 || overdueQueued > 0 || expiredLeases > 0;

		return {
			id: 'scheduled_jobs',
			title: 'Фоновые задания',
			status: hasProblem ? 'warning' : 'ok',
			message: hasProblem
				? `FAILED: ${failed}, QUEUED с задержкой > 15 минут: ${overdueQueued}, просроченных lease: ${expiredLeases}`
				: 'Ошибок, длительной задержки и просроченных lease нет'
		};
	}

	private async checkS3(): Promise<HealthCheck> {
		const mode = this.configService.get<string>('MODE');
		if (mode !== 'production') {
			return {
				id: 's3',
				title: 'S3 хранилище',
				status: 'disabled',
				message: 'В текущем режиме файлы сохраняются локально'
			};
		}

		const required = [
			'S3_BUCKET',
			'S3_ACCESS_KEY_ID',
			'S3_SECRET_ACCESS_KEY'
		];
		const missing = required.filter(key => !this.configService.get(key));

		if (missing.length > 0) {
			return {
				id: 's3',
				title: 'S3 хранилище',
				status: 'warning',
				message: `Не настроены переменные: ${missing.join(', ')}`
			};
		}

		return this.measure('s3', 'S3 хранилище', async () => {
			const client = new S3Client({
				endpoint:
					this.configService.get<string>('S3_ENDPOINT') ||
					'https://s3.twcstorage.ru',
				region: this.configService.get<string>('S3_REGION') || 'ru-1',
				forcePathStyle:
					this.configService.get<string>('S3_FORCE_PATH_STYLE') !==
					'false',
				credentials: {
					accessKeyId: this.configService.get<string>('S3_ACCESS_KEY_ID'),
					secretAccessKey: this.configService.get<string>(
						'S3_SECRET_ACCESS_KEY'
					)
				}
			});

			await client.send(
				new HeadBucketCommand({
					Bucket: this.configService.get<string>('S3_BUCKET')
				})
			);

			return 'Бакет доступен';
		});
	}

	private async checkSmtp(): Promise<HealthCheck> {
		const required = ['SMTP_SERVER', 'SMTP_LOGIN', 'SMTP_PASSWORD'];
		const missing = required.filter(key => !this.configService.get(key));

		if (missing.length > 0) {
			return {
				id: 'smtp',
				title: 'Email SMTP',
				status: 'warning',
				message: `Не настроены переменные: ${missing.join(', ')}`
			};
		}

		return this.measure('smtp', 'Email SMTP', async () => {
			const isProduction =
				this.configService.get<string>('MODE') === 'production';
			const transport = createTransport({
				host: this.configService.get<string>('SMTP_SERVER'),
				port: isProduction ? 465 : 2525,
				secure: isProduction,
				connectionTimeout: 3000,
				greetingTimeout: 3000,
				socketTimeout: 3000,
				auth: {
					user: this.configService.get<string>('SMTP_LOGIN'),
					pass: this.configService.get<string>('SMTP_PASSWORD')
				}
			});

			await transport.verify();
			transport.close();

			return 'SMTP подключение работает';
		});
	}

	private async checkSmsAero(): Promise<HealthCheck> {
		const email = this.configService.get<string>('SMSAERO_EMAIL');
		const apiKey = this.configService.get<string>('SMSAERO_API_KEY');

		if (!email || !apiKey) {
			return {
				id: 'smsaero',
				title: 'SMS Aero',
				status: 'warning',
				message: 'Не настроены SMSAERO_EMAIL или SMSAERO_API_KEY'
			};
		}

		return this.measure('smsaero', 'SMS Aero', async () => {
			const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');
			const response = await this.fetchWithTimeout(
				'https://gate.smsaero.ru/v2/balance',
				{
					headers: {
						Authorization: `Basic ${auth}`
					}
				}
			);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			return 'Сервис отвечает';
		});
	}

	private async checkRecaptcha(): Promise<HealthCheck> {
		const enabled =
			this.configService.get<string>('RECAPTCHA_ENABLED') === 'true';
		const secret = this.configService.get<string>('RECAPTCHA_SECRET_KEY');

		if (!enabled) {
			return {
				id: 'recaptcha',
				title: 'reCAPTCHA',
				status: 'disabled',
				message: 'Проверка отключена переменной RECAPTCHA_ENABLED'
			};
		}

		return {
			id: 'recaptcha',
			title: 'reCAPTCHA',
			status: secret ? 'ok' : 'warning',
			message: secret
				? 'Ключ настроен'
				: 'Не настроен RECAPTCHA_SECRET_KEY'
		};
	}

	private async checkYooKassa(
		resultPromise: Promise<BillingOverviewResult> = this.getBillingResult()
	): Promise<HealthCheck> {
		const result = await resultPromise;
		if (result.billingOwner === false) {
			return {
				id: 'yookassa',
				title: 'ЮKassa',
				status: 'disabled',
				message: 'До cutover конфигурация остаётся на стороне Core'
			};
		}
		if (!result.overview || result.error) {
			return {
				id: 'yookassa',
				title: 'ЮKassa',
				status: 'down',
				message: result.error || 'Billing internal API недоступен'
			};
		}
		const worker = result.overview.heartbeats?.find(
			heartbeat => heartbeat.service === 'billing-worker'
		);
		if (worker?.status === 'down') {
			return {
				id: 'yookassa',
				title: 'ЮKassa',
				status: 'down',
				message: 'Billing worker не готов'
			};
		}
		const configured = result.overview.providers?.yookassa;
		if (configured === undefined) {
			return {
				id: 'yookassa',
				title: 'ЮKassa',
				status: 'warning',
				message: 'Billing worker ещё не опубликовал состояние конфигурации'
			};
		}

		return {
			id: 'yookassa',
			title: 'ЮKassa',
			status: configured ? 'ok' : 'warning',
			message: configured
				? 'Платёжные ключи настроены в Billing worker'
				: 'Платёжные ключи не настроены в Billing worker'
		};
	}

	private async checkInfoTelegramBot(): Promise<HealthCheck> {
		return this.checkTelegramBot({
			id: 'telegram_info_bot',
			title: '@winwidget_info_bot',
			tokenKey: 'TELEGRAM_INFO_BOT_TOKEN',
			usernameKey: 'TELEGRAM_INFO_BOT_USERNAME'
		});
	}

	private async checkSupportTelegramBot(): Promise<HealthCheck> {
		return this.checkTelegramBot({
			id: 'telegram_support_bot',
			title: '@winwidget_support_bot',
			tokenKey: 'TELEGRAM_SUPPORT_BOT_TOKEN',
			usernameKey: 'TELEGRAM_SUPPORT_BOT_USERNAME'
		});
	}

	private async checkTelegramBot({
		id,
		title,
		tokenKey,
		usernameKey
	}: {
		id: string;
		title: string;
		tokenKey: string;
		usernameKey?: string;
	}): Promise<HealthCheck> {
		const token = this.configService.get<string>(tokenKey);
		const username = usernameKey
			? this.configService.get<string>(usernameKey)
			: null;
		const missing = [
			!token ? tokenKey : null,
			usernameKey && !username ? usernameKey : null
		].filter((key): key is string => Boolean(key));

		if (missing.length > 0) {
			return {
				id,
				title,
				status: 'warning',
				message: `Не настроены переменные: ${missing.join(', ')}`
			};
		}

		return this.measure(id, title, async () => {
			const response = await this.fetchWithTimeout(
				`https://api.telegram.org/bot${token}/getMe`
			);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const data = (await response.json()) as { ok?: boolean };
			if (!data.ok) {
				throw new Error('Telegram returned ok=false');
			}

			return `${title} отвечает`;
		});
	}

	private async measure(
		id: string,
		title: string,
		check: () => Promise<string>
	): Promise<HealthCheck> {
		const startedAt = Date.now();

		try {
			const message = await this.withTimeout(check());

			return {
				id,
				title,
				status: 'ok',
				message,
				latencyMs: Date.now() - startedAt
			};
		} catch (error) {
			return {
				id,
				title,
				status: 'down',
				message:
					error instanceof Error
						? error.message
						: 'Проверка завершилась ошибкой',
				latencyMs: Date.now() - startedAt
			};
		}
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs = 4000) {
		let timeout: NodeJS.Timeout;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error('Проверка превысила лимит ожидания')),
				timeoutMs
			);
		});

		try {
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async fetchWithTimeout(
		url: string,
		init: RequestInit = {},
		timeoutMs = 3000
	) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);

		try {
			return await fetch(url, {
				...init,
				signal: controller.signal
			});
		} finally {
			clearTimeout(timeout);
		}
	}
}
