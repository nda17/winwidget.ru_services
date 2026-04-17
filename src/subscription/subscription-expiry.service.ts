import { PrismaService } from '@/prisma.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

@Injectable()
export class SubscriptionExpiryService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly RUN_HOURS_MOSCOW = [3, 15]; // 03:00 и 15:00 МСК
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly logger = new Logger(SubscriptionExpiryService.name);
	private expiryTimeout: NodeJS.Timeout | null = null;

	constructor(private prisma: PrismaService) {}

	async onModuleInit() {
		const expired = await this.expireSubscriptions();
		this.logger.log(
			`Startup check: deactivated ${expired} expired subscription(s).`
		);
		this.scheduleNext();
	}

	onModuleDestroy() {
		if (this.expiryTimeout) {
			clearTimeout(this.expiryTimeout);
			this.expiryTimeout = null;
		}
	}

	private async expireSubscriptions(): Promise<number> {
		const result = await this.prisma.subscription.updateMany({
			where: {
				status: SubscriptionStatus.ACTIVE,
				plan: { not: Plan.TRIAL },
				expiresAt: { lt: new Date() }
			},
			data: { status: SubscriptionStatus.EXPIRED }
		});
		return result.count;
	}

	private scheduleNext() {
		const nextRun = this.getNextRunDate();
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);

		const mskTime = new Date(
			nextRun.getTime() + this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000
		);
		this.logger.log(
			`Next subscription expiry check scheduled for ${mskTime.toISOString().replace('T', ' ').slice(0, 16)} MSK.`
		);

		this.expiryTimeout = setTimeout(async () => {
			try {
				const expired = await this.expireSubscriptions();
				this.logger.log(
					`Scheduled check complete: deactivated ${expired} expired subscription(s).`
				);
			} catch (err) {
				this.logger.error('Subscription expiry check failed:', err);
			} finally {
				this.scheduleNext();
			}
		}, delay);

		this.expiryTimeout.unref?.();
	}

	/** Возвращает ближайший из слотов 03:00 / 15:00 МСК в UTC */
	private getNextRunDate(): Date {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const nowMsk = new Date(Date.now() + offsetMs);

		const candidates: Date[] = [];

		for (const hour of this.RUN_HOURS_MOSCOW) {
			// Сегодня в <hour>:00 МСК
			const candidate = new Date(nowMsk);
			candidate.setUTCHours(hour, 0, 0, 0);
			if (candidate.getTime() > nowMsk.getTime()) {
				candidates.push(new Date(candidate.getTime() - offsetMs));
			}
			// Завтра в <hour>:00 МСК
			const tomorrow = new Date(candidate);
			tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
			candidates.push(new Date(tomorrow.getTime() - offsetMs));
		}

		return candidates.reduce((min, d) => (d < min ? d : min));
	}
}
