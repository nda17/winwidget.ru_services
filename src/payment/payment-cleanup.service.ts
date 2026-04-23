import { PrismaService } from '@/prisma.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

@Injectable()
export class PaymentCleanupService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly NIGHTLY_CLEANUP_HOUR_MOSCOW = 2;
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly STALE_PAYMENT_AGE_HOURS = 2;
	private readonly logger = new Logger(PaymentCleanupService.name);
	private readonly isDevMode = process.env.MODE === 'development';
	private cleanupTimeout: NodeJS.Timeout | null = null;

	constructor(private prisma: PrismaService) {}

	async onModuleInit() {
		const deletedCount = await this.cleanupStalePendingPayments();

		if (this.isDevMode) {
			this.logger.log(
				`Startup cleanup finished: removed ${deletedCount} stale pending payment(s).`
			);
		}

		this.scheduleNightlyCleanup();
	}

	onModuleDestroy() {
		if (this.cleanupTimeout) {
			clearTimeout(this.cleanupTimeout);
			this.cleanupTimeout = null;
		}
	}

	async runManualCleanup() {
		const deletedCount = await this.cleanupStalePendingPayments();

		this.logger.log(
			`Manual cleanup finished: removed ${deletedCount} stale pending payment(s).`
		);

		return deletedCount;
	}

	async cleanupStalePendingPaymentsForUser(userId: string) {
		const deletedCount = await this.cleanupStalePendingPayments({
			userId
		});

		if (deletedCount > 0) {
			this.logger.log(
				`Pre-payment cleanup finished for user ${userId}: removed ${deletedCount} stale pending payment(s).`
			);
		}

		return deletedCount;
	}

	private async cleanupStalePendingPayments(options?: {
		userId?: string;
	}) {
		const staleThreshold = new Date(
			Date.now() - this.STALE_PAYMENT_AGE_HOURS * 60 * 60 * 1000
		);

		const result = await this.prisma.payment.deleteMany({
			where: {
				status: PaymentStatus.PENDING,
				createdAt: { lt: staleThreshold },
				...(options?.userId ? { userId: options.userId } : {})
			}
		});

		return result.count;
	}

	private scheduleNightlyCleanup() {
		const nextRun = this.getNextMoscowCleanupDate();
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);

		if (this.isDevMode) {
			this.logger.log(
				`Next payment cleanup scheduled for ${nextRun.toISOString()} (02:00 MSK).`
			);
		}

		this.cleanupTimeout = setTimeout(async () => {
			try {
				const deletedCount = await this.cleanupStalePendingPayments();

				if (this.isDevMode) {
					this.logger.log(
						`Nightly cleanup finished: removed ${deletedCount} stale pending payment(s).`
					);
				}
			} finally {
				this.scheduleNightlyCleanup();
			}
		}, delay);

		this.cleanupTimeout.unref?.();
	}

	private getNextMoscowCleanupDate() {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedNextRun = new Date(shiftedNow);

		shiftedNextRun.setUTCHours(this.NIGHTLY_CLEANUP_HOUR_MOSCOW, 0, 0, 0);

		if (shiftedNextRun.getTime() <= shiftedNow.getTime()) {
			shiftedNextRun.setUTCDate(shiftedNextRun.getUTCDate() + 1);
		}

		return new Date(shiftedNextRun.getTime() - offsetMs);
	}
}
