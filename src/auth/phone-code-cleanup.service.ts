import { PrismaService } from '@/prisma.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';

@Injectable()
export class PhoneCodeCleanupService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly NIGHTLY_CLEANUP_HOUR_MOSCOW = 1;
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly logger = new Logger(PhoneCodeCleanupService.name);
	private readonly isDevMode = process.env.MODE === 'development';
	private cleanupTimeout: NodeJS.Timeout | null = null;

	constructor(private prisma: PrismaService) {}

	async onModuleInit() {
		const deletedCount = await this.cleanupExpiredPhoneVerificationCodes();

		if (this.isDevMode) {
			this.logger.log(
				`Startup cleanup finished: removed ${deletedCount} expired phone verification code(s).`
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

	private async cleanupExpiredPhoneVerificationCodes() {
		const result = await this.prisma.phoneVerificationCode.deleteMany({
			where: {
				expiresAt: {
					lt: new Date()
				}
			}
		});

		return result.count;
	}

	private scheduleNightlyCleanup() {
		const nextRun = this.getNextMoscowCleanupDate();
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);

		if (this.isDevMode) {
			this.logger.log(
				`Next phone code cleanup scheduled for ${nextRun.toISOString()} (01:00 MSK).`
			);
		}

		this.cleanupTimeout = setTimeout(async () => {
			try {
				const deletedCount =
					await this.cleanupExpiredPhoneVerificationCodes();

				if (this.isDevMode) {
					this.logger.log(
						`Nightly cleanup finished: removed ${deletedCount} expired phone verification code(s).`
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
