import {
	BadRequestException,
	ConflictException,
	Injectable
} from '@nestjs/common';
import { Prisma } from '@prisma/operations-client';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { ensureSchedulesSeparated } from '../telegram/telegram-settings.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

@Injectable()
export class ReportingPolicyService {
	constructor(private readonly prisma: OperationsPrismaService) {}

	async reserve(value: unknown) {
		const request = this.reservation(value);
		return this.prisma.$transaction(async transaction => {
			await this.ensureRows(transaction);
			const policy = await this.lock(transaction);
			const settings =
				await transaction.telegramBotSettings.findUniqueOrThrow({
					where: { id: 'singleton' }
				});
			ensureSchedulesSeparated(
				request.scheduleTime,
				settings.databaseBackupTime
			);
			const expected = BigInt(request.expectedScheduleGeneration);
			const next = expected + 1n;
			if (policy.pendingChangeId) {
				if (
					policy.pendingChangeId === request.changeId &&
					policy.pendingTime === request.scheduleTime &&
					policy.pendingGeneration === next
				) {
					return {
						accepted: true as const,
						changeId: request.changeId,
						reservationGeneration: next.toString(),
						confirmationRequired: true
					};
				}
				throw new ConflictException(
					'A schedule-policy confirmation is already pending'
				);
			}
			if (policy.reservationGeneration !== expected) {
				throw new ConflictException(
					'Daily Summary schedule generation changed'
				);
			}
			if (policy.reservationTime === request.scheduleTime) {
				return {
					accepted: true as const,
					changeId: request.changeId,
					reservationGeneration: expected.toString(),
					confirmationRequired: false
				};
			}
			await transaction.reportingSchedulePolicy.update({
				where: { id: 'singleton' },
				data: {
					pendingChangeId: request.changeId,
					pendingTime: request.scheduleTime,
					pendingGeneration: next
				}
			});
			return {
				accepted: true as const,
				changeId: request.changeId,
				reservationGeneration: next.toString(),
				confirmationRequired: true
			};
		});
	}

	async confirm(value: unknown) {
		const request = this.confirmation(value);
		return this.prisma.$transaction(async transaction => {
			await this.ensureRows(transaction);
			const policy = await this.lock(transaction);
			const generation = BigInt(request.scheduleGeneration);
			if (!policy.pendingChangeId) {
				if (
					policy.confirmedChangeId === request.changeId &&
					policy.reservationGeneration === generation
				) {
					return {
						confirmed: true as const,
						changeId: request.changeId,
						reservationGeneration: generation.toString()
					};
				}
				throw new ConflictException(
					'No matching schedule policy reservation'
				);
			}
			if (
				policy.pendingChangeId !== request.changeId ||
				policy.pendingGeneration !== generation ||
				!policy.pendingTime
			) {
				throw new ConflictException(
					'Schedule policy reservation mismatch'
				);
			}
			await transaction.reportingSchedulePolicy.update({
				where: { id: 'singleton' },
				data: {
					reservationTime: policy.pendingTime,
					reservationGeneration: generation,
					confirmedChangeId: request.changeId,
					pendingChangeId: null,
					pendingTime: null,
					pendingGeneration: null
				}
			});
			return {
				confirmed: true as const,
				changeId: request.changeId,
				reservationGeneration: generation.toString()
			};
		});
	}

	private ensureRows(transaction: Prisma.TransactionClient) {
		return Promise.all([
			transaction.telegramBotSettings.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			}),
			transaction.reportingSchedulePolicy.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			})
		]);
	}

	private async lock(transaction: Prisma.TransactionClient) {
		await transaction.$queryRaw`
			SELECT "id"
			FROM "operations"."reporting_schedule_policy"
			WHERE "id" = 'singleton'
			FOR UPDATE
		`;
		return transaction.reportingSchedulePolicy.findUniqueOrThrow({
			where: { id: 'singleton' }
		});
	}

	private reservation(value: unknown) {
		const record = this.record(value);
		const keys = Object.keys(record).sort();
		if (
			keys.join(',') !==
				'actorId,changeId,expectedScheduleGeneration,scheduleTime' ||
			typeof record.changeId !== 'string' ||
			!UUID_PATTERN.test(record.changeId) ||
			typeof record.scheduleTime !== 'string' ||
			!TIME_PATTERN.test(record.scheduleTime) ||
			typeof record.expectedScheduleGeneration !== 'string' ||
			!/^(?:0|[1-9]\d*)$/.test(record.expectedScheduleGeneration) ||
			typeof record.actorId !== 'string' ||
			!record.actorId.trim() ||
			record.actorId.length > 255
		) {
			throw new BadRequestException(
				'Daily Summary schedule policy request is invalid'
			);
		}
		return {
			changeId: record.changeId,
			scheduleTime: record.scheduleTime,
			expectedScheduleGeneration: record.expectedScheduleGeneration,
			actorId: record.actorId
		};
	}

	private confirmation(value: unknown) {
		const record = this.record(value);
		const keys = Object.keys(record).sort();
		if (
			keys.join(',') !== 'changeId,scheduleGeneration' ||
			typeof record.changeId !== 'string' ||
			!UUID_PATTERN.test(record.changeId) ||
			typeof record.scheduleGeneration !== 'string' ||
			!/^(?:0|[1-9]\d*)$/.test(record.scheduleGeneration)
		) {
			throw new BadRequestException(
				'Daily Summary schedule confirmation is invalid'
			);
		}
		return {
			changeId: record.changeId,
			scheduleGeneration: record.scheduleGeneration
		};
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new BadRequestException(
				'Daily Summary schedule policy request is invalid'
			);
		}
		return value as Record<string, unknown>;
	}
}
