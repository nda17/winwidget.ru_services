import {
	CORE_OWNED_MESSAGING_KINDS,
	getMessagingQueueHealthExpectations,
	MONOLITH_INTEGRATION_KINDS,
	MESSAGING_QUEUE_NAMES,
	NOTIFICATION_DELIVERY_KINDS,
	OUTBOX_LOCK_TIMEOUT_MS,
	WIDGETS_PROVIDER_INTEGRATION_KINDS
} from '@/messaging/messaging.constants';
import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	BillingMessagingClientService,
	BillingMessagingOverview
} from '@/messaging/billing-messaging-client.service';
import { parseMessagingHeartbeatMetadata } from '@/messaging/messaging-heartbeat.service';
import {
	NotificationDeliveryClientService,
	NotificationDeliveryOverview
} from '@/messaging/notification-delivery-client.service';
import {
	RabbitMqManagementService,
	RabbitQueueInfo
} from '@/messaging/rabbitmq-management.service';
import {
	WidgetsDeliveryFailuresClientService,
	WidgetsMessagingOverview
} from '@/messaging/widgets-delivery-failures-client.service';
import { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	OutboxEventStatus,
	Prisma,
	ScheduledJobRunStatus
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

const REQUIRED_SERVICES = [
	'outbox-publisher',
	'integration-worker',
	'maintenance-worker'
] as const;
const ALERT_STATE_JOB_TYPE = 'MESSAGING_OPERATIONAL_ALERT_STATE';
const ALERT_STATE_SCHEDULE_KEY = 'singleton';
const ALERT_STATE_HEALTHY = 'healthy';
const ALERT_CLAIM_LEASE_MS = 4 * 60 * 1000;
const ALERT_RETRY_DELAY_MS = 5 * 60 * 1000;

const getRabbitQueueDepth = (queue: RabbitQueueInfo): number =>
	Math.max(
		queue.messages,
		queue.messages_ready + queue.messages_unacknowledged
	);

@Injectable()
export class MessagingOperationalAlertService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(
		MessagingOperationalAlertService.name
	);
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly prisma: PrismaService,
		private readonly telegramBot: TelegramBotService,
		private readonly configService: ConfigService,
		private readonly rabbitManagement: RabbitMqManagementService,
		private readonly notificationDelivery: NotificationDeliveryClientService,
		private readonly widgets: WidgetsDeliveryFailuresClientService,
		private readonly billingState?: BillingCoreStateService,
		private readonly billingMessaging?: BillingMessagingClientService
	) {}

	onModuleInit(): void {
		if (!this.isEnabled()) return;
		this.timer = setInterval(() => void this.check(), 5 * 60 * 1000);
		this.timer.unref();
		setTimeout(() => void this.check(), 30_000).unref();
	}

	onModuleDestroy(): void {
		if (this.timer) clearInterval(this.timer);
	}

	private async check(): Promise<void> {
		try {
			const billingOwner = this.billingState
				? await this.billingState.isBillingOwner()
				: false;
			const coreFailureKinds = CORE_OWNED_MESSAGING_KINDS.filter(
				kind => !billingOwner || kind !== 'auto-renewal'
			);
			const now = new Date();
			const staleBefore = new Date(now.getTime() - 30_000);
			const activityStaleBefore = new Date(
				now.getTime() - this.getActivityStaleMs()
			);
			const oldPendingBefore = new Date(now.getTime() - 15 * 60 * 1000);
			const expiredPublishingBefore = new Date(
				now.getTime() - OUTBOX_LOCK_TIMEOUT_MS
			);
			const stalePublishingBefore = new Date(
				oldPendingBefore.getTime() - OUTBOX_LOCK_TIMEOUT_MS
			);
			const [
				failedOutbox,
				stalePendingOutbox,
				dueOutbox,
				unresolvedDlq,
				dlqByCategory,
				failedScheduledJobs,
				staleScheduledJobs,
				heartbeats,
				queueResult,
				brokerResult,
				notificationDeliveryResult,
				widgetsResult,
				billingResult
			] = await Promise.all([
				this.prisma.outboxEvent.count({
					where: { status: OutboxEventStatus.FAILED }
				}),
				this.prisma.outboxEvent.count({
					where: {
						OR: [
							{
								status: OutboxEventStatus.PENDING,
								availableAt: { lt: oldPendingBefore }
							},
							{
								status: OutboxEventStatus.PUBLISHING,
								OR: [
									{ lockedAt: null },
									{ lockedAt: { lt: stalePublishingBefore } }
								]
							}
						]
					}
				}),
				this.prisma.outboxEvent.count({
					where: {
						OR: [
							{
								status: OutboxEventStatus.PENDING,
								availableAt: { lte: now }
							},
							{
								status: OutboxEventStatus.PUBLISHING,
								OR: [
									{ lockedAt: null },
									{ lockedAt: { lte: expiredPublishingBefore } }
								]
							}
						]
					}
				}),
				this.prisma.integrationDeliveryFailure.count({
					where: {
						resolvedAt: null,
						integration: {
							in: coreFailureKinds
						}
					}
				}),
				this.prisma.integrationDeliveryFailure.groupBy({
					by: ['category', 'normalizedCode'],
					where: {
						resolvedAt: null,
						integration: {
							in: coreFailureKinds
						}
					},
					_count: { _all: true }
				}),
				this.prisma.scheduledJobRun.count({
					where: {
						status: 'FAILED',
						jobType: { not: ALERT_STATE_JOB_TYPE }
					}
				}),
				this.prisma.scheduledJobRun.count({
					where: {
						jobType: { not: ALERT_STATE_JOB_TYPE },
						OR: [
							{
								status: 'QUEUED',
								availableAt: { lt: oldPendingBefore }
							},
							{
								status: 'PROCESSING',
								leaseExpiresAt: { lt: now }
							}
						]
					}
				}),
				this.prisma.messagingHeartbeat.findMany({
					where: { service: { in: [...REQUIRED_SERVICES] } },
					orderBy: { lastSeenAt: 'desc' },
					select: {
						service: true,
						lastSeenAt: true,
						metadata: true
					}
				}),
				this.rabbitManagement
					.getMessagingQueues()
					.then(queues => ({ queues, error: null as string | null }))
					.catch(error => ({
						queues: [],
						error:
							error instanceof Error
								? error.message
								: 'RabbitMQ Management API недоступен'
					})),
				this.rabbitManagement
					.getBrokerHealth()
					.then(health => ({ health, error: null as string | null }))
					.catch(error => ({
						health: null,
						error:
							error instanceof Error
								? error.message
								: 'Состояние RabbitMQ недоступно'
					})),
				this.notificationDelivery
					.getOverview()
					.then(overview => ({
						overview,
						error: null as string | null
					}))
					.catch(error => ({
						overview: null,
						error:
							error instanceof Error
								? error.message
								: 'Notification Delivery недоступен'
					})),
				this.widgets
					.getOverview()
					.then(overview => ({
						overview,
						error: null as string | null
					}))
					.catch(error => ({
						overview: null,
						error:
							error instanceof Error ? error.message : 'Widgets недоступен'
					})),
				billingOwner && this.billingMessaging
					? this.billingMessaging
							.getOverview()
							.then(overview => ({
								overview,
								error: null as string | null
							}))
							.catch(error => ({
								overview: null,
								error:
									error instanceof Error
										? error.message
										: 'Billing недоступен'
							}))
					: Promise.resolve({ overview: null, error: null })
			]);

			const categoryCounts: Record<string, number> = {};
			for (const item of dlqByCategory) {
				const key =
					!item.category || item.normalizedCode === 'UNCLASSIFIED'
						? 'UNCLASSIFIED'
						: item.category;
				categoryCounts[key] =
					(categoryCounts[key] || 0) + item._count._all;
			}
			for (const [category, count] of Object.entries(
				notificationDeliveryResult.overview?.operational
					.unresolvedFailuresByCategory || {}
			) as Array<[string, number]>) {
				categoryCounts[category] = (categoryCounts[category] || 0) + count;
			}
			for (const [category, count] of Object.entries(
				widgetsResult.overview?.operational.unresolvedFailuresByCategory ||
					{}
			) as Array<[string, number]>) {
				categoryCounts[category] = (categoryCounts[category] || 0) + count;
			}
			for (const [category, count] of Object.entries(
				billingResult.overview?.operational
					?.unresolvedFailuresByCategory || {}
			) as Array<[string, number]>) {
				categoryCounts[category] = (categoryCounts[category] || 0) + count;
			}

			const queueExpectations = getMessagingQueueHealthExpectations({
				billingOwner
			});
			const requiredQueues = queueExpectations.map(
				expectation => expectation.name
			);
			const messagingQueues: RabbitQueueInfo[] = queueResult.queues;
			const queuesByName = new Map<string, RabbitQueueInfo>(
				messagingQueues.map(queue => [queue.name, queue] as const)
			);
			const missingQueues = queueResult.error
				? []
				: requiredQueues.filter(queue => !queuesByName.has(queue));
			const consumerlessQueues = queueResult.error
				? []
				: queueExpectations
						.filter(
							expectation =>
								expectation.consumerExpectation === 'at-least-one'
						)
						.filter(expectation => {
							const state = queuesByName.get(expectation.name);
							return state && state.consumers < 1;
						})
						.map(expectation => expectation.name);
			const unexpectedlyConsumedQueues = queueResult.error
				? []
				: queueExpectations
						.filter(
							expectation => expectation.consumerExpectation === 'none'
						)
						.filter(expectation => {
							const state = queuesByName.get(expectation.name);
							return state && state.consumers > 0;
						})
						.map(expectation => expectation.name);
			const stoppedQueues = messagingQueues
				.filter(
					queue => queue.state === 'down' || queue.state === 'stopped'
				)
				.map(queue => queue.name);
			const backlogThreshold = this.getBacklogThreshold();
			const backloggedQueueDepths = new Map(
				messagingQueues
					.filter(queue => getRabbitQueueDepth(queue) >= backlogThreshold)
					.map(queue => [queue.name, getRabbitQueueDepth(queue)] as const)
			);
			for (const expectation of queueExpectations) {
				if (!expectation.alertOnAnyMessage) continue;
				const queue = queuesByName.get(expectation.name);
				if (!queue) continue;
				const depth = getRabbitQueueDepth(queue);
				if (depth > 0) backloggedQueueDepths.set(queue.name, depth);
			}
			const backloggedQueues = [...backloggedQueueDepths].map(
				([queue, depth]) => `${queue}=${depth}`
			);
			const queuedMessages = messagingQueues.reduce(
				(total, queue) => total + getRabbitQueueDepth(queue),
				0
			);
			const getQueueMessages = (
				kinds: readonly (keyof typeof MESSAGING_QUEUE_NAMES)[]
			) =>
				messagingQueues
					.filter(queue =>
						kinds.some(kind => {
							const mainQueue = MESSAGING_QUEUE_NAMES[kind];
							return (
								queue.name === mainQueue ||
								queue.name.startsWith(`${mainQueue}.`)
							);
						})
					)
					.reduce((total, queue) => total + getRabbitQueueDepth(queue), 0);

			const serviceStates = Object.fromEntries(
				REQUIRED_SERVICES.map(service => {
					const instances = heartbeats.filter(
						heartbeat => heartbeat.service === service
					);
					const latest = instances[0];
					const activity = this.getLatestActivity(
						instances.map(instance => instance.metadata)
					);
					return [
						service,
						{
							heartbeatFresh:
								Boolean(latest) && latest.lastSeenAt >= staleBefore,
							...activity
						}
					];
				})
			) as Record<
				(typeof REQUIRED_SERVICES)[number],
				{
					heartbeatFresh: boolean;
					pollAt: Date | null;
					publishAt: Date | null;
					consumeAt: Date | null;
				}
			>;
			const publisherPollStale =
				!serviceStates['outbox-publisher'].pollAt ||
				serviceStates['outbox-publisher'].pollAt < staleBefore;
			const publisherPublishStale =
				dueOutbox > 0 &&
				(!serviceStates['outbox-publisher'].publishAt ||
					serviceStates['outbox-publisher'].publishAt <
						activityStaleBefore);
			const integrationQueueMessages = getQueueMessages(
				MONOLITH_INTEGRATION_KINDS.filter(
					kind => !billingOwner || kind !== 'auto-renewal'
				)
			);
			const notificationDeliveryQueueMessages = getQueueMessages(
				NOTIFICATION_DELIVERY_KINDS
			);
			const widgetsQueueMessages = getQueueMessages(
				WIDGETS_PROVIDER_INTEGRATION_KINDS
			);
			const maintenanceQueueMessages = getQueueMessages([
				'database-backup'
			]);
			const integrationConsumeStale =
				integrationQueueMessages > 0 &&
				(!serviceStates['integration-worker'].consumeAt ||
					serviceStates['integration-worker'].consumeAt <
						activityStaleBefore);
			const maintenanceConsumeStale =
				maintenanceQueueMessages > 0 &&
				(!serviceStates['maintenance-worker'].consumeAt ||
					serviceStates['maintenance-worker'].consumeAt <
						activityStaleBefore);
			const deliveryOverview: NotificationDeliveryOverview | null =
				notificationDeliveryResult.overview;
			const deliveryHeartbeatFresh =
				deliveryOverview?.heartbeat.status === 'ok';
			const deliveryPublishAt = this.parseDate(
				deliveryOverview?.heartbeat.lastSuccessfulPublishAt || undefined
			);
			const deliveryConsumeAt = this.parseDate(
				deliveryOverview?.heartbeat.lastSuccessfulConsumeAt || undefined
			);
			const deliveryPublishStale =
				(deliveryOverview?.operational.dueOutbox || 0) > 0 &&
				(!deliveryPublishAt || deliveryPublishAt < activityStaleBefore);
			const deliveryConsumeStale =
				notificationDeliveryQueueMessages > 0 &&
				(!deliveryConsumeAt || deliveryConsumeAt < activityStaleBefore);
			const widgetsOverview: WidgetsMessagingOverview | null =
				widgetsResult.overview;
			const billingOverview: BillingMessagingOverview | null =
				billingResult.overview;
			const billingDue =
				billingOverview?.operational?.dueOutbox ??
				(billingOverview?.outbox.PENDING || 0) +
					(billingOverview?.outbox.PROCESSING || 0);
			const billingStale =
				billingOverview?.operational?.staleOutbox ??
				(billingOverview?.oldestPendingAt &&
				Date.parse(billingOverview.oldestPendingAt) <
					oldPendingBefore.getTime()
					? 1
					: 0);
			const billingHeartbeatProblems = billingOwner
				? billingOverview?.heartbeats
					? billingOverview.heartbeats
							.filter(heartbeat => heartbeat.status === 'down')
							.map(heartbeat => heartbeat.service)
					: [
							'billing-api',
							'billing-scheduler',
							'billing-worker',
							'billing-outbox-publisher'
						]
				: [];
			const widgetsPublisher = widgetsOverview?.heartbeats.find(
				heartbeat => heartbeat.service === 'widgets-publisher'
			);
			const widgetsWorker = widgetsOverview?.heartbeats.find(
				heartbeat => heartbeat.service === 'widgets-worker'
			);
			const widgetsHeartbeatProblems =
				widgetsOverview?.heartbeats
					.filter(heartbeat => heartbeat.status === 'down')
					.map(heartbeat => heartbeat.service) || [];
			const widgetsPublishAt = this.parseDate(
				widgetsPublisher?.lastSuccessfulPublishAt || undefined
			);
			const widgetsConsumeAt = this.parseDate(
				widgetsWorker?.lastSuccessfulConsumeAt || undefined
			);
			const widgetsPublishStale =
				(widgetsOverview?.operational.dueOutbox || 0) > 0 &&
				(!widgetsPublishAt || widgetsPublishAt < activityStaleBefore);
			const widgetsConsumeStale =
				widgetsQueueMessages > 0 &&
				(!widgetsConsumeAt || widgetsConsumeAt < activityStaleBefore);
			const combinedFailedOutbox =
				failedOutbox +
				(deliveryOverview?.outbox.FAILED || 0) +
				(widgetsOverview?.outbox.FAILED || 0);
			const combinedStaleOutbox =
				stalePendingOutbox +
				(deliveryOverview?.operational.staleOutbox || 0) +
				(widgetsOverview?.operational.staleOutbox || 0) +
				billingStale;
			const combinedDueOutbox =
				dueOutbox +
				(deliveryOverview?.operational.dueOutbox || 0) +
				(widgetsOverview?.operational.dueOutbox || 0) +
				billingDue;
			const combinedUnresolvedFailures =
				unresolvedDlq +
				(deliveryOverview?.unresolvedFailures || 0) +
				(widgetsOverview?.unresolvedFailures || 0) +
				(billingOverview?.unresolvedFailures || 0);

			const brokerProblems = [
				...(brokerResult.error
					? [`management=${brokerResult.error}`]
					: []),
				...(brokerResult.health?.nodes.length === 0
					? ['nodes=empty']
					: []),
				...(brokerResult.health?.alarmNodes.map(node => `alarm=${node}`) ||
					[]),
				...(brokerResult.health?.stoppedNodes.map(
					node => `stopped=${node}`
				) || []),
				...(brokerResult.health?.partitionedNodes.map(
					node => `partition=${node}`
				) || [])
			];
			const heartbeatProblems = REQUIRED_SERVICES.filter(
				service => !serviceStates[service].heartbeatFresh
			);
			const problems = [
				combinedFailedOutbox
					? `outbox-failed=${combinedFailedOutbox}`
					: '',
				combinedStaleOutbox ? `outbox-stale=${combinedStaleOutbox}` : '',
				combinedUnresolvedFailures
					? `dlq=${combinedUnresolvedFailures}`
					: '',
				failedScheduledJobs ? `jobs-failed=${failedScheduledJobs}` : '',
				staleScheduledJobs ? `jobs-stale=${staleScheduledJobs}` : '',
				...heartbeatProblems.map(service => `heartbeat=${service}`),
				...(publisherPollStale ? ['publisher-poll=stale'] : []),
				...(publisherPublishStale ? ['publisher-publish=stale'] : []),
				...(integrationConsumeStale ? ['integration-consume=stale'] : []),
				...(maintenanceConsumeStale ? ['maintenance-consume=stale'] : []),
				...(notificationDeliveryResult.error
					? [
							`notification-delivery-api=${notificationDeliveryResult.error}`
						]
					: []),
				...(!notificationDeliveryResult.error && !deliveryHeartbeatFresh
					? ['heartbeat=notification-delivery-worker']
					: []),
				...(deliveryPublishStale
					? ['notification-delivery-publish=stale']
					: []),
				...(deliveryConsumeStale
					? ['notification-delivery-consume=stale']
					: []),
				...(widgetsResult.error
					? [`widgets-api=${widgetsResult.error}`]
					: []),
				...(!widgetsResult.error
					? widgetsHeartbeatProblems.map(service => `heartbeat=${service}`)
					: []),
				...(widgetsPublishStale ? ['widgets-publish=stale'] : []),
				...(widgetsConsumeStale ? ['widgets-consume=stale'] : []),
				...(billingResult.error
					? [`billing-api=${billingResult.error}`]
					: []),
				...(!billingResult.error
					? billingHeartbeatProblems.map(service => `heartbeat=${service}`)
					: []),
				...(queueResult.error ? [`queues=${queueResult.error}`] : []),
				...missingQueues.map(queue => `missing=${queue}`),
				...consumerlessQueues.map(queue => `consumers=0:${queue}`),
				...unexpectedlyConsumedQueues.map(queue => `consumers>0:${queue}`),
				...stoppedQueues.map(queue => `state:${queue}`),
				...backloggedQueues.map(queue => `backlog:${queue}`),
				...brokerProblems
			].filter(Boolean);
			const signature = problems.sort().join('|');

			const problemMessage = [
				'<b>Проблема в очередях интеграций</b>',
				`Outbox FAILED: <b>${combinedFailedOutbox}</b>`,
				`Outbox PENDING/PUBLISHING старше 15 минут: <b>${combinedStaleOutbox}</b>`,
				`Outbox готов к публикации: <b>${combinedDueOutbox}</b>`,
				`DLQ не обработано: <b>${combinedUnresolvedFailures}</b>`,
				`— временные: <b>${categoryCounts.TRANSIENT || 0}</b>`,
				`— rate limit: <b>${categoryCounts.RATE_LIMIT || 0}</b>`,
				`— постоянные: <b>${categoryCounts.PERMANENT || 0}</b>`,
				`— авторизация/настройка: <b>${categoryCounts.AUTH_CONFIGURATION || 0}</b>`,
				`— без классификации: <b>${categoryCounts.UNCLASSIFIED || 0}</b>`,
				`Scheduled jobs FAILED: <b>${failedScheduledJobs}</b>`,
				`Scheduled jobs с задержкой/просроченным lease: <b>${staleScheduledJobs}</b>`,
				`RabbitMQ messages: <b>${queuedMessages}</b>`,
				`RabbitMQ problems: <b>${
					[
						queueResult.error || '',
						...missingQueues,
						...consumerlessQueues,
						...unexpectedlyConsumedQueues,
						...stoppedQueues,
						...backloggedQueues,
						...brokerProblems
					]
						.filter(Boolean)
						.join(', ') || 'нет'
				}</b>`,
				`Outbox publisher: <b>${this.describeService(
					serviceStates['outbox-publisher'].heartbeatFresh,
					publisherPollStale || publisherPublishStale
				)}</b>`,
				`Integration worker: <b>${this.describeService(
					serviceStates['integration-worker'].heartbeatFresh,
					integrationConsumeStale
				)}</b>`,
				`Maintenance worker: <b>${this.describeService(
					serviceStates['maintenance-worker'].heartbeatFresh,
					maintenanceConsumeStale
				)}</b>`,
				`Notification Delivery: <b>${
					notificationDeliveryResult.error
						? `internal API недоступен: ${notificationDeliveryResult.error}`
						: this.describeService(
								deliveryHeartbeatFresh,
								deliveryPublishStale || deliveryConsumeStale
							)
				}</b>`,
				`Widgets: <b>${
					widgetsResult.error
						? `internal API недоступен: ${widgetsResult.error}`
						: this.describeService(
								widgetsHeartbeatProblems.length === 0,
								widgetsPublishStale || widgetsConsumeStale
							)
				}</b>`,
				`Billing: <b>${
					billingOwner
						? billingResult.error
							? `internal API недоступен: ${billingResult.error}`
							: `${
									billingHeartbeatProblems.length ? 'нет heartbeat, ' : ''
								}Outbox=${billingDue}, DLQ=${billingOverview?.unresolvedFailures || 0}`
						: 'Core ownership'
				}</b>`
			].join('\n');
			await this.sendAlertIfChanged(
				signature,
				signature
					? problemMessage
					: '<b>Очереди интеграций восстановлены</b>\nRabbitMQ, publisher и workers работают, необработанных ошибок нет.'
			);
		} catch (error) {
			this.logger.error(
				`Messaging alert check failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async sendAlertIfChanged(
		signature: string,
		message: string
	): Promise<void> {
		const stateSignature = signature
			? createHash('sha256').update(signature).digest('hex')
			: ALERT_STATE_HEALTHY;
		const now = new Date();
		const leaseToken = randomUUID();
		const claim = await this.prisma.$transaction(async transaction => {
			const [lock] = await transaction.$queryRaw<
				Array<{ acquired: boolean }>
			>(
				Prisma.sql`
					SELECT pg_try_advisory_xact_lock(
						hashtext(${ALERT_STATE_JOB_TYPE}),
						hashtext(${ALERT_STATE_SCHEDULE_KEY})
					) AS "acquired"
				`
			);
			if (!lock?.acquired) return null;

			let state = await transaction.scheduledJobRun.findUnique({
				where: {
					jobType_scheduleKey: {
						jobType: ALERT_STATE_JOB_TYPE,
						scheduleKey: ALERT_STATE_SCHEDULE_KEY
					}
				}
			});
			if (!state) {
				state = await transaction.scheduledJobRun.create({
					data: {
						jobType: ALERT_STATE_JOB_TYPE,
						scheduleKey: ALERT_STATE_SCHEDULE_KEY,
						status: ScheduledJobRunStatus.SUCCEEDED,
						scheduledFor: now,
						availableAt: now,
						finishedAt: now,
						result: { signature: ALERT_STATE_HEALTHY }
					}
				});
				if (stateSignature === ALERT_STATE_HEALTHY) return null;
			}

			const sentSignature = this.getStoredAlertSignature(state.result);
			if (sentSignature === stateSignature) return null;
			const pendingClaimExpiresAt = this.getPendingAlertClaimExpiresAt(
				state.checkpoint
			);
			if (pendingClaimExpiresAt && pendingClaimExpiresAt > now)
				return null;
			if (state.availableAt > now) return null;

			await transaction.scheduledJobRun.update({
				where: { id: state.id },
				data: {
					status: ScheduledJobRunStatus.SUCCEEDED,
					scheduledFor: now,
					startedAt: now,
					attempts: { increment: 1 },
					checkpoint: {
						pendingSignature: stateSignature,
						claimToken: leaseToken,
						claimExpiresAt: new Date(
							now.getTime() + ALERT_CLAIM_LEASE_MS
						).toISOString()
					},
					lastError: null
				}
			});
			return { id: state.id, leaseToken, stateSignature };
		});
		if (!claim) return;

		try {
			await this.telegramBot.sendMessagingOperationalAlert(message);
		} catch (error) {
			const availableAt = new Date(Date.now() + ALERT_RETRY_DELAY_MS);
			const lastError = (
				error instanceof Error ? error.message : String(error)
			).slice(0, 4000);
			await this.prisma.$executeRaw(
				Prisma.sql`
					UPDATE "scheduled_job_runs"
					SET
						"checkpoint" = '{}'::jsonb,
						"available_at" = ${availableAt},
						"last_error" = ${lastError},
						"updated_at" = NOW()
					WHERE "id" = ${claim.id}::uuid
						AND "checkpoint" ->> 'claimToken' = ${claim.leaseToken}
				`
			);
			throw error;
		}

		await this.prisma.$executeRaw(
			Prisma.sql`
				UPDATE "scheduled_job_runs"
				SET
					"result" = jsonb_build_object(
						'signature',
						${claim.stateSignature}::text
					),
					"checkpoint" = '{}'::jsonb,
					"finished_at" = NOW(),
					"last_error" = NULL,
					"updated_at" = NOW()
				WHERE "id" = ${claim.id}::uuid
					AND "checkpoint" ->> 'claimToken' = ${claim.leaseToken}
			`
		);
	}

	private getStoredAlertSignature(value: Prisma.JsonValue | null): string {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return ALERT_STATE_HEALTHY;
		}
		return typeof value.signature === 'string'
			? value.signature
			: ALERT_STATE_HEALTHY;
	}

	private getPendingAlertClaimExpiresAt(
		value: Prisma.JsonValue
	): Date | null {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return null;
		}
		return this.parseDate(
			typeof value.claimExpiresAt === 'string'
				? value.claimExpiresAt
				: undefined
		);
	}

	private getLatestActivity(metadataValues: Prisma.JsonValue[]) {
		const dates = metadataValues.map(value => {
			const metadata = parseMessagingHeartbeatMetadata(value);
			return {
				pollAt: this.parseDate(metadata.lastSuccessfulPollAt),
				publishAt: this.parseDate(metadata.lastSuccessfulPublishAt),
				consumeAt: this.parseDate(metadata.lastSuccessfulConsumeAt)
			};
		});
		const latest = (key: 'pollAt' | 'publishAt' | 'consumeAt') =>
			dates.reduce<Date | null>((result, value) => {
				const current = value[key];
				return current && (!result || current > result) ? current : result;
			}, null);
		return {
			pollAt: latest('pollAt'),
			publishAt: latest('publishAt'),
			consumeAt: latest('consumeAt')
		};
	}

	private parseDate(value?: string): Date | null {
		if (!value) return null;
		const timestamp = Date.parse(value);
		return Number.isFinite(timestamp) ? new Date(timestamp) : null;
	}

	private describeService(
		heartbeatFresh: boolean,
		activityStale: boolean
	): string {
		if (!heartbeatFresh) return 'нет heartbeat';
		if (activityStale) return 'процесс жив, activity зависла';
		return 'работает';
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

	private getBacklogThreshold(): number {
		const configured = Number(
			this.configService.get<string>(
				'MESSAGING_QUEUE_BACKLOG_ALERT_THRESHOLD'
			) || 100
		);
		return Number.isInteger(configured) && configured >= 1
			? Math.min(configured, 1_000_000)
			: 100;
	}

	private isEnabled(): boolean {
		const configured = this.configService.get<string>(
			'MESSAGING_ALERTS_ENABLED'
		);
		if (configured !== undefined) return configured === 'true';
		return this.configService.get<string>('MODE') === 'production';
	}
}
