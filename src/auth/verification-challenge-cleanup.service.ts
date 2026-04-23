import { PrismaService } from '@/prisma.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';

@Injectable()
export class VerificationChallengeCleanupService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly NIGHTLY_CLEANUP_HOUR_MOSCOW = 1;
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly logger = new Logger(
		VerificationChallengeCleanupService.name
	);
	private readonly isDevMode = process.env.MODE === 'development';
	private cleanupTimeout: NodeJS.Timeout | null = null;

	constructor(private prisma: PrismaService) {}

	async onModuleInit() {
		const deletedCount = await this.cleanupExpiredVerificationChallenges();

		if (this.isDevMode) {
			this.logger.log(
				`Startup cleanup finished: removed ${deletedCount} expired verification challenge(s).`
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
		const deletedCount = await this.cleanupExpiredVerificationChallenges();

		this.logger.log(
			`Manual cleanup finished: removed ${deletedCount} expired verification challenge(s).`
		);

		return deletedCount;
	}

	private async cleanupExpiredVerificationChallenges() {
		const result = await this.prisma.verificationChallenge.deleteMany({
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
				`Next verification challenge cleanup scheduled for ${nextRun.toISOString()} (01:00 MSK).`
			);
		}

		this.cleanupTimeout = setTimeout(async () => {
			try {
				const deletedCount =
					await this.cleanupExpiredVerificationChallenges();

				if (this.isDevMode) {
					this.logger.log(
						`Nightly cleanup finished: removed ${deletedCount} expired verification challenge(s).`
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
