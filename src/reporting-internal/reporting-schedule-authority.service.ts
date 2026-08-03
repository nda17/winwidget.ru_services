import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { PrismaService } from '@/prisma.service';
import { ensureReportingBackupScheduleSeparated } from '@/telegram-bot/telegram-bot.service';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACTOR_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,255}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DailySummaryPolicyStateRow {
	dailySummaryOwner: string;
	dailySummaryPolicyReservationTime: string;
	dailySummaryPolicyReservationGeneration: bigint;
	dailySummaryPolicyConfirmedChangeId: string | null;
	dailySummaryPolicyPendingChangeId: string | null;
	dailySummaryPolicyPendingTime: string | null;
	dailySummaryPolicyPendingGeneration: bigint | null;
}

interface SchedulePolicyReservationRequest {
	changeId: string;
	scheduleTime: string;
	expectedScheduleGeneration: string;
	actorId: string;
}

interface SchedulePolicyConfirmationRequest {
	changeId: string;
	scheduleGeneration: string;
}

export interface SchedulePolicyReservationResponse {
	accepted: true;
	changeId: string;
	reservationGeneration: string;
	confirmationRequired: boolean;
}

export interface SchedulePolicyConfirmationResponse {
	confirmed: true;
	changeId: string;
	reservationGeneration: string;
}

class ScheduleOwnerConflictException extends ConflictException {
	constructor() {
		super({
			code: 'SCHEDULE_OWNER_CONFLICT',
			message: 'Daily Summary settings are not owned by Reporting yet'
		});
	}
}

class ScheduleVersionConflictException extends ConflictException {
	constructor() {
		super({
			code: 'SCHEDULE_VERSION_CONFLICT',
			message: 'Daily Summary schedule changed; reload settings'
		});
	}
}

class SchedulePolicyPendingException extends ConflictException {
	constructor() {
		super({
			code: 'SCHEDULE_POLICY_CONFIRMATION_PENDING',
			message:
				'A previous Daily Summary backup-policy reservation must be confirmed first'
		});
	}
}

@Injectable()
export class ReportingSchedulePolicyService {
	private readonly logger = new Logger(
		ReportingSchedulePolicyService.name
	);

	constructor(
		private readonly prisma: PrismaService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async reserve(
		value: unknown,
		correlationId: string
	): Promise<SchedulePolicyReservationResponse> {
		let parsedRequest: SchedulePolicyReservationRequest | undefined;
		try {
			parsedRequest = this.parseReservationRequest(value);
			const request = parsedRequest;
			const result = await this.prisma.$transaction(async transaction => {
				await transaction.telegramBotSettings.upsert({
					where: { id: 'singleton' },
					update: {},
					create: { id: 'singleton' }
				});
				await this.lockTelegramSettings(transaction);
				const current = await this.lockPolicyState(transaction);
				if (current.dailySummaryOwner !== 'REPORTING') {
					throw new ScheduleOwnerConflictException();
				}

				const settings =
					await transaction.telegramBotSettings.findUniqueOrThrow({
						where: { id: 'singleton' },
						select: { databaseBackupTime: true }
					});
				ensureReportingBackupScheduleSeparated(
					request.scheduleTime,
					settings.databaseBackupTime
				);

				const expectedGeneration = BigInt(
					request.expectedScheduleGeneration
				);
				const pendingGeneration = expectedGeneration + 1n;
				if (current.dailySummaryPolicyPendingChangeId) {
					if (
						current.dailySummaryPolicyPendingChangeId ===
							request.changeId &&
						current.dailySummaryPolicyPendingTime ===
							request.scheduleTime &&
						current.dailySummaryPolicyPendingGeneration ===
							pendingGeneration
					) {
						return {
							accepted: true as const,
							changeId: request.changeId,
							reservationGeneration: pendingGeneration.toString(),
							confirmationRequired: true
						};
					}
					throw new SchedulePolicyPendingException();
				}
				if (
					current.dailySummaryPolicyReservationGeneration !==
					expectedGeneration
				) {
					throw new ScheduleVersionConflictException();
				}
				if (
					current.dailySummaryPolicyReservationTime ===
					request.scheduleTime
				) {
					return {
						accepted: true as const,
						changeId: request.changeId,
						reservationGeneration: expectedGeneration.toString(),
						confirmationRequired: false
					};
				}

				await transaction.reportingProducerState.update({
					where: { id: 'singleton' },
					data: {
						dailySummaryPolicyPendingChangeId: request.changeId,
						dailySummaryPolicyPendingTime: request.scheduleTime,
						dailySummaryPolicyPendingGeneration: pendingGeneration
					}
				});
				return {
					accepted: true as const,
					changeId: request.changeId,
					reservationGeneration: pendingGeneration.toString(),
					confirmationRequired: true
				};
			});
			this.logger.log(
				`Daily Summary backup-policy reservation accepted generation=${result.reservationGeneration} confirmationRequired=${result.confirmationRequired} correlationId=${correlationId}`
			);
			return result;
		} catch (error) {
			if (
				error instanceof BadRequestException ||
				error instanceof ConflictException
			) {
				const reasonCode =
					error instanceof ScheduleVersionConflictException
						? 'STALE_GENERATION'
						: error instanceof ScheduleOwnerConflictException
							? 'OWNER_NOT_REPORTING'
							: error instanceof SchedulePolicyPendingException
								? 'CONFIRMATION_PENDING'
								: parsedRequest
									? 'BACKUP_SCHEDULE_CONFLICT'
									: 'INVALID_REQUEST';
				this.logger.warn(
					`Daily Summary backup-policy reservation rejected reason=${reasonCode} correlationId=${correlationId}`
				);
				const actorId =
					parsedRequest?.actorId ?? this.extractAuditableActorId(value);
				if (actorId) {
					await this.adminEventLog.record({
						adminId: actorId,
						section: 'REPORTING',
						action: 'REPORTING_DAILY_SUMMARY_SCHEDULE_REJECTED',
						description:
							'Отклонено резервирование policy расписания Daily Summary',
						entityType: 'reporting_schedule_policy',
						entityId: 'daily-summary',
						entityLabel: 'Daily Summary',
						metadata: { reasonCode, correlationId }
					});
				}
			}
			throw error;
		}
	}

	async confirm(
		value: unknown,
		correlationId: string
	): Promise<SchedulePolicyConfirmationResponse> {
		const request = this.parseConfirmationRequest(value);
		const result = await this.prisma.$transaction(async transaction => {
			await transaction.telegramBotSettings.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			});
			await this.lockTelegramSettings(transaction);
			const current = await this.lockPolicyState(transaction);
			if (current.dailySummaryOwner !== 'REPORTING') {
				throw new ScheduleOwnerConflictException();
			}
			const generation = BigInt(request.scheduleGeneration);
			if (!current.dailySummaryPolicyPendingChangeId) {
				if (
					current.dailySummaryPolicyConfirmedChangeId ===
						request.changeId &&
					current.dailySummaryPolicyReservationGeneration === generation
				) {
					return {
						confirmed: true as const,
						changeId: request.changeId,
						reservationGeneration: generation.toString()
					};
				}
				throw new ScheduleVersionConflictException();
			}
			if (
				current.dailySummaryPolicyPendingChangeId !== request.changeId ||
				current.dailySummaryPolicyPendingGeneration !== generation ||
				!current.dailySummaryPolicyPendingTime
			) {
				throw new SchedulePolicyPendingException();
			}
			await transaction.reportingProducerState.update({
				where: { id: 'singleton' },
				data: {
					dailySummaryPolicyReservationTime:
						current.dailySummaryPolicyPendingTime,
					dailySummaryPolicyReservationGeneration: generation,
					dailySummaryPolicyConfirmedChangeId: request.changeId,
					dailySummaryPolicyPendingChangeId: null,
					dailySummaryPolicyPendingTime: null,
					dailySummaryPolicyPendingGeneration: null
				}
			});
			return {
				confirmed: true as const,
				changeId: request.changeId,
				reservationGeneration: generation.toString()
			};
		});
		this.logger.log(
			`Daily Summary backup-policy reservation confirmed generation=${result.reservationGeneration} correlationId=${correlationId}`
		);
		return result;
	}

	private async lockTelegramSettings(
		transaction: Prisma.TransactionClient
	): Promise<void> {
		const rows = await transaction.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`
				SELECT "id"
				FROM "telegram_bot_settings"
				WHERE "id" = 'singleton'
				FOR UPDATE
			`
		);
		if (rows.length !== 1) {
			throw new Error('Telegram settings row is missing');
		}
	}

	private async lockPolicyState(
		transaction: Prisma.TransactionClient
	): Promise<DailySummaryPolicyStateRow> {
		const rows = await transaction.$queryRaw<DailySummaryPolicyStateRow[]>(
			Prisma.sql`
				SELECT
					"daily_summary_owner" AS "dailySummaryOwner",
					"daily_summary_schedule_time" AS "dailySummaryPolicyReservationTime",
					"daily_summary_schedule_generation" AS "dailySummaryPolicyReservationGeneration",
					"daily_summary_policy_confirmed_change_id" AS "dailySummaryPolicyConfirmedChangeId",
					"daily_summary_policy_pending_change_id" AS "dailySummaryPolicyPendingChangeId",
					"daily_summary_policy_pending_time" AS "dailySummaryPolicyPendingTime",
					"daily_summary_policy_pending_generation" AS "dailySummaryPolicyPendingGeneration"
				FROM "reporting_producer_state"
				WHERE "id" = 'singleton'
				FOR UPDATE
			`
		);
		if (rows.length !== 1) {
			throw new Error('Daily Summary policy state is missing');
		}
		return this.validateState(rows[0]);
	}

	private validateState(
		state: DailySummaryPolicyStateRow
	): DailySummaryPolicyStateRow {
		const pendingValues = [
			state.dailySummaryPolicyPendingChangeId,
			state.dailySummaryPolicyPendingTime,
			state.dailySummaryPolicyPendingGeneration
		];
		const hasPending = pendingValues.every(value => value !== null);
		if (
			!['CORE', 'REPORTING'].includes(state.dailySummaryOwner) ||
			!SCHEDULE_TIME_PATTERN.test(
				state.dailySummaryPolicyReservationTime
			) ||
			state.dailySummaryPolicyReservationGeneration < 0n ||
			(!hasPending && pendingValues.some(value => value !== null)) ||
			(hasPending &&
				(state.dailySummaryOwner !== 'REPORTING' ||
					!UUID_PATTERN.test(state.dailySummaryPolicyPendingChangeId!) ||
					!SCHEDULE_TIME_PATTERN.test(
						state.dailySummaryPolicyPendingTime!
					) ||
					state.dailySummaryPolicyPendingGeneration !==
						state.dailySummaryPolicyReservationGeneration + 1n))
		) {
			throw new Error('Daily Summary policy state is invalid');
		}
		return state;
	}

	private extractAuditableActorId(value: unknown): string | null {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return null;
		}
		const actorId = (value as Record<string, unknown>).actorId;
		return typeof actorId === 'string' && ACTOR_ID_PATTERN.test(actorId)
			? actorId
			: null;
	}

	private parseReservationRequest(
		value: unknown
	): SchedulePolicyReservationRequest {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new BadRequestException(
				'Daily Summary schedule policy request is invalid'
			);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (
			keys.length !== 4 ||
			keys[0] !== 'actorId' ||
			keys[1] !== 'changeId' ||
			keys[2] !== 'expectedScheduleGeneration' ||
			keys[3] !== 'scheduleTime' ||
			typeof record.changeId !== 'string' ||
			!UUID_PATTERN.test(record.changeId) ||
			typeof record.scheduleTime !== 'string' ||
			!SCHEDULE_TIME_PATTERN.test(record.scheduleTime) ||
			typeof record.expectedScheduleGeneration !== 'string' ||
			!/^(?:0|[1-9]\d*)$/.test(record.expectedScheduleGeneration) ||
			typeof record.actorId !== 'string' ||
			!ACTOR_ID_PATTERN.test(record.actorId)
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

	private parseConfirmationRequest(
		value: unknown
	): SchedulePolicyConfirmationRequest {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new BadRequestException(
				'Daily Summary schedule policy confirmation is invalid'
			);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (
			keys.length !== 2 ||
			keys[0] !== 'changeId' ||
			keys[1] !== 'scheduleGeneration' ||
			typeof record.changeId !== 'string' ||
			!UUID_PATTERN.test(record.changeId) ||
			typeof record.scheduleGeneration !== 'string' ||
			!/^(?:0|[1-9]\d*)$/.test(record.scheduleGeneration)
		) {
			throw new BadRequestException(
				'Daily Summary schedule policy confirmation is invalid'
			);
		}
		return {
			changeId: record.changeId,
			scheduleGeneration: record.scheduleGeneration
		};
	}
}
