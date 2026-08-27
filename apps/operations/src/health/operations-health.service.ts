import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OperationsFederationClient } from '../federation/operations-federation.client';
import { AdminAuditConsumerService } from '../messaging/admin-audit-consumer.service';
import { MaintenanceWorkerService } from '../maintenance/maintenance-worker.service';
import { MessagingAdminService } from '../messaging-admin/messaging-admin.service';
import { OperationsHeartbeatService } from '../monitoring/operations-heartbeat.service';
import { OperationsOutboxPublisherService } from '../messaging/operations-outbox-publisher.service';
import { OperationsRabbitMqService } from '../messaging/operations-rabbitmq.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { DatabaseRestoreWorkerService } from '../restore/database-restore-worker.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';

@Injectable()
export class OperationsHealthService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly runtime: OperationsRuntimeService,
		private readonly rabbit: OperationsRabbitMqService,
		private readonly consumer: AdminAuditConsumerService,
		private readonly publisher: OperationsOutboxPublisherService,
		private readonly maintenanceWorker: MaintenanceWorkerService,
		private readonly restoreWorker: DatabaseRestoreWorkerService,
		private readonly heartbeat: OperationsHeartbeatService,
		private readonly messagingAdmin: MessagingAdminService,
		private readonly federation: OperationsFederationClient,
		private readonly config: ConfigService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const identity = await this.prisma.serviceIdentity.findUnique({
				where: { id: 'singleton' },
				select: { serviceName: true, databaseId: true }
			});
			if (
				identity?.serviceName !== 'operations-service' ||
				!identity.databaseId
			) {
				throw new Error('Operations database identity is invalid');
			}
		} catch {
			throw new ServiceUnavailableException(
				'Operations database is not ready'
			);
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (this.runtime.workerEnabled && !this.consumer.isReady()) {
			throw new ServiceUnavailableException(
				'Operations audit consumer is not ready'
			);
		}
		if (this.runtime.workerEnabled && !this.maintenanceWorker.isReady()) {
			throw new ServiceUnavailableException(
				'Operations maintenance worker is not ready'
			);
		}
		if (
			this.runtime.restoreWorkerEnabled &&
			!this.restoreWorker.isReady()
		) {
			throw new ServiceUnavailableException(
				'Operations database restore worker is not ready'
			);
		}
		if (this.runtime.outboxPublisherEnabled && !this.publisher.isReady()) {
			throw new ServiceUnavailableException(
				'Operations Outbox publisher is not ready'
			);
		}
		if (!this.heartbeat.isReady()) {
			throw new ServiceUnavailableException(
				'Operations heartbeat is not ready'
			);
		}
		return this.status('ready');
	}

	deployment() {
		return {
			service: 'operations',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	async admin() {
		const [database, messaging, identityChecks] = await Promise.all([
			this.measure('database', 'База данных', async () => {
				await this.prisma.$queryRaw`SELECT 1`;
				return 'Подключение к Operations DB работает';
			}),
			this.messagingAdmin.getOverview(),
			this.federation
				.getIdentityAdminHealth()
				.then(checks => this.healthChecks(checks))
				.catch(() => [
					{
						id: 'smtp',
						title: 'Email SMTP',
						status: 'down' as const,
						message: 'Identity provider health недоступен'
					},
					{
						id: 'smsaero',
						title: 'SMS Aero',
						status: 'down' as const,
						message: 'Identity provider health недоступен'
					},
					{
						id: 'recaptcha',
						title: 'reCAPTCHA',
						status: 'down' as const,
						message: 'Identity provider health недоступен'
					}
				])
		]);
		const serviceErrors = [
			[
				'notification_delivery',
				'Notification Delivery',
				messaging.notificationDeliveryError
			],
			['widgets', 'Widgets', messaging.widgetsError],
			['billing', 'Billing', messaging.billingError],
			['identity', 'Identity', messaging.identityError],
			['campaigns', 'Campaigns', messaging.campaignsError],
			['reporting', 'Reporting', messaging.reportingError],
			['support', 'Support', messaging.supportError],
			['platform', 'Platform', messaging.platformError]
		] as const;
		const oldestAgeSeconds = messaging.oldestPendingAt
			? Math.max(
					0,
					Math.round(
						(Date.now() - Date.parse(messaging.oldestPendingAt)) / 1_000
					)
				)
			: 0;
		const messagingProblem =
			messaging.outbox.FAILED > 0 ||
			messaging.unresolvedFailures > 0 ||
			oldestAgeSeconds > 60;
		const telegramInfoBotConfigured =
			this.config
				.get<string>('TELEGRAM_INFO_BOT_CONFIGURED')
				?.trim()
				.toLowerCase() === 'true';
		const heartbeatChecks = messaging.heartbeats
			.filter((value: unknown): value is Record<string, unknown> =>
				Boolean(
					value && typeof value === 'object' && !Array.isArray(value)
				)
			)
			.filter(value =>
				String(value.service || '').startsWith('operations-')
			)
			.map(value => ({
				id: String(value.service).replace(/-/g, '_'),
				title: String(value.service),
				status:
					value.status === 'ok' ? ('ok' as const) : ('down' as const),
				message:
					value.status === 'ok'
						? `Активных instances: ${Number(value.activeInstances) || 0}`
						: 'Heartbeat не получен'
			}));
		return {
			generatedAt: new Date().toISOString(),
			mode: this.config.get<string>('MODE') || 'development',
			uptimeSeconds: Math.round(process.uptime()),
			checks: [
				{
					id: 'backend',
					title: 'Бекенд',
					status: 'ok',
					message: 'Operations API отвечает'
				},
				database,
				{
					id: 'rabbitmq',
					title: 'RabbitMQ',
					status: messaging.rabbitMqError ? 'down' : 'ok',
					message:
						messaging.rabbitMqError ||
						`${messaging.queues.length} очередей доступны`
				},
				...serviceErrors.map(([id, title, error]) => ({
					id,
					title,
					status: error ? ('down' as const) : ('ok' as const),
					message: error || 'Internal API отвечает'
				})),
				...heartbeatChecks,
				{
					id: 'messaging_backlog',
					title: 'Очередь интеграций',
					status: messagingProblem ? 'warning' : 'ok',
					message: messagingProblem
						? `Outbox FAILED: ${messaging.outbox.FAILED}, DLQ: ${messaging.unresolvedFailures}, старейшее ожидание: ${oldestAgeSeconds} сек.`
						: 'Задержек и необработанных ошибок нет'
				},
				{
					id: 'scheduled_jobs',
					title: 'Database backup',
					status:
						messaging.completedBackupsLast24Hours > 0 ? 'ok' : 'warning',
					message: `Успешных backup за 24 часа: ${messaging.completedBackupsLast24Hours}`
				},
				{
					id: 'telegram_info_bot',
					title: 'Telegram Info Bot',
					status: telegramInfoBotConfigured ? 'ok' : 'warning',
					message: telegramInfoBotConfigured
						? 'Токен настроен в Operations worker'
						: 'Токен не настроен'
				},
				...identityChecks
			]
		};
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'operations',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	private async measure(
		id: string,
		title: string,
		action: () => Promise<string>
	) {
		const startedAt = Date.now();
		try {
			return {
				id,
				title,
				status: 'ok' as const,
				message: await action(),
				latencyMs: Date.now() - startedAt
			};
		} catch {
			return {
				id,
				title,
				status: 'down' as const,
				message: 'Проверка недоступна',
				latencyMs: Date.now() - startedAt
			};
		}
	}

	private healthChecks(value: unknown[]) {
		return value.flatMap(item => {
			if (!item || typeof item !== 'object' || Array.isArray(item))
				return [];
			const record = item as Record<string, unknown>;
			if (
				typeof record.id !== 'string' ||
				typeof record.title !== 'string' ||
				typeof record.message !== 'string' ||
				!['ok', 'warning', 'down', 'disabled'].includes(
					String(record.status)
				)
			) {
				return [];
			}
			return [
				{
					id: record.id,
					title: record.title,
					status: record.status,
					message: record.message,
					...(Number.isFinite(record.latencyMs)
						? { latencyMs: Number(record.latencyMs) }
						: {})
				}
			];
		});
	}
}
