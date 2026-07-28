import { PAYMENT_RECONCILIATION_INTERVAL_MS } from '@/payment/payment.constants';
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
	private readonly logger = new Logger(PaymentCleanupService.name);
	private maintenanceTimer: NodeJS.Timeout | null = null;
	private destroyed = false;

	constructor(private readonly prisma: PrismaService) {}

	onModuleInit(): void {
		this.maintenanceTimer = setTimeout(() => {
			this.maintenanceTimer = null;
			void this.runScheduledMaintenance();
		}, 0);
		this.maintenanceTimer.unref?.();
	}

	onModuleDestroy(): void {
		this.destroyed = true;
		if (this.maintenanceTimer) {
			clearTimeout(this.maintenanceTimer);
			this.maintenanceTimer = null;
		}
	}

	async runManualCleanup(): Promise<number> {
		const expiredCount = await this.expireStalePendingPayments();
		this.logger.log(
			`Manual payment reconciliation marked ${expiredCount} checkout(s) expired.`
		);
		return expiredCount;
	}

	async cleanupStalePendingPaymentsForUser(
		userId: string
	): Promise<number> {
		return this.expireStalePendingPayments(userId);
	}

	async expireStalePendingPayments(userId?: string): Promise<number> {
		const now = new Date();
		const result = await this.prisma.payment.updateMany({
			where: {
				status: PaymentStatus.PENDING,
				checkoutExpiresAt: { lte: now },
				...(userId ? { userId } : {})
			},
			data: {
				status: PaymentStatus.EXPIRED,
				confirmationUrl: null
			}
		});
		return result.count;
	}

	private async runScheduledMaintenance(): Promise<void> {
		if (this.destroyed) return;
		try {
			const expiredCount = await this.expireStalePendingPayments();
			if (expiredCount > 0) {
				this.logger.log(
					`Payment reconciliation marked ${expiredCount} checkout(s) expired.`
				);
			}
		} catch (error) {
			this.logger.error(
				`Payment reconciliation failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			if (!this.destroyed) {
				this.maintenanceTimer = setTimeout(() => {
					this.maintenanceTimer = null;
					void this.runScheduledMaintenance();
				}, PAYMENT_RECONCILIATION_INTERVAL_MS);
				this.maintenanceTimer.unref?.();
			}
		}
	}
}
