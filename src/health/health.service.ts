import { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import { PrismaService } from '@/prisma.service';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
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

@Injectable()
export class HealthService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly configService: ConfigService,
		private readonly rabbitManagement: RabbitMqManagementService
	) {}

	async getAdminHealth() {
		const checks = await Promise.all([
			this.checkBackend(),
			this.checkDatabase(),
			this.checkRabbitMq(),
			this.checkMessagingHeartbeat('outbox-publisher', 'Outbox publisher'),
			this.checkMessagingHeartbeat(
				'integration-worker',
				'Integration worker'
			),
			this.checkMessagingHeartbeat(
				'maintenance-worker',
				'Maintenance worker'
			),
			this.checkMessagingBacklog(),
			this.checkScheduledJobs(),
			this.checkS3(),
			this.checkSmtp(),
			this.checkSmsAero(),
			this.checkRecaptcha(),
			this.checkYooKassa(),
			this.checkInfoTelegramBot(),
			this.checkAuthTelegramBot(),
			this.checkSupportTelegramBot()
		]);

		return {
			generatedAt: new Date().toISOString(),
			mode: this.configService.get<string>('MODE') || 'development',
			uptimeSeconds: Math.round(process.uptime()),
			checks
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
		return this.measure('rabbitmq', 'RabbitMQ', () =>
			this.rabbitManagement.checkConnection()
		);
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

	private async checkMessagingBacklog(): Promise<HealthCheck> {
		const [failedOutbox, unresolvedFailures, oldestPending] =
			await Promise.all([
				this.prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
				this.prisma.integrationDeliveryFailure.count({
					where: { resolvedAt: null }
				}),
				this.prisma.outboxEvent.findFirst({
					where: { status: { in: ['PENDING', 'PUBLISHING'] } },
					orderBy: { createdAt: 'asc' },
					select: { createdAt: true }
				})
			]);
		const oldestAgeSeconds = oldestPending
			? Math.round((Date.now() - oldestPending.createdAt.getTime()) / 1000)
			: 0;
		const hasProblem =
			failedOutbox > 0 || unresolvedFailures > 0 || oldestAgeSeconds > 60;

		return {
			id: 'messaging_backlog',
			title: 'Очередь интеграций',
			status: hasProblem ? 'warning' : 'ok',
			message: hasProblem
				? `Outbox FAILED: ${failedOutbox}, DLQ: ${unresolvedFailures}, старейшее ожидание: ${oldestAgeSeconds} сек.`
				: 'Задержек и необработанных ошибок нет'
		};
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

	private async checkYooKassa(): Promise<HealthCheck> {
		const isProduction =
			this.configService.get<string>('MODE') === 'production';
		const shopIdKey = isProduction
			? 'YOOKASSA_PRODUCTION_SHOP_ID'
			: 'YOOKASSA_SHOP_ID';
		const secretKey = isProduction
			? 'YOOKASSA_PRODUCTION_SECRET_KEY'
			: 'YOOKASSA_SECRET_KEY';

		const configured =
			Boolean(this.configService.get<string>(shopIdKey)) &&
			Boolean(this.configService.get<string>(secretKey));

		return {
			id: 'yookassa',
			title: 'ЮKassa',
			status: configured ? 'ok' : 'warning',
			message: configured
				? 'Платёжные ключи настроены'
				: `Не настроены ${shopIdKey} или ${secretKey}`
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

	private async checkAuthTelegramBot(): Promise<HealthCheck> {
		return this.checkTelegramBot({
			id: 'telegram_auth_bot',
			title: '@nda-auth_bot',
			tokenKey: 'TELEGRAM_AUTH_BOT_TOKEN',
			usernameKey: 'TELEGRAM_AUTH_BOT_USERNAME'
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
