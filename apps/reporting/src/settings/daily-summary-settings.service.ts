import { createReportingCorrelationId } from '../common/reporting-context';
import { CoreInternalClient } from '../internal/core-internal.client';
import {
	ADMIN_AUDIT_EVENT_TYPE,
	REPORTING_ADMIN_AUDIT_ROUTING_KEY
} from '../messaging/reporting-messaging.constants';
import {
	REPORTING_SETTINGS_AUDIT_FIELDS,
	ReportingSettingsAdminAuditEvent,
	ReportingSettingsAuditField,
	assertReportingAdminAuditEvent
} from '../messaging/reporting-published-event.contract';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { UpdateDailySummarySettingsDto } from './daily-summary-settings.dto';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	ReportingOutboxExchange,
	ReportingOutboxStatus,
	ReportingOwner,
	ReportingSettings
} from '@prisma/reporting-client';
import { createHash, randomUUID } from 'node:crypto';

export interface FinalDailySummaryConfig {
	enabled: boolean;
	destinationChatId: string | null;
	messageThreadId: number | null;
	coreOperationalAlertsDestinationChatId: string | null;
	coreOperationalAlertsThreadId: number | null;
	scheduleTime: string;
	timezone: string;
}

export function validateDailySummarySettingsConfig(
	config: FinalDailySummaryConfig
): void {
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.scheduleTime)) {
		throw new BadRequestException('scheduleTime must use HH:mm format');
	}
	try {
		new Intl.DateTimeFormat('en-US', {
			timeZone: config.timezone
		}).format();
	} catch {
		throw new BadRequestException(
			'timezone must be a valid IANA time zone'
		);
	}
	if (config.timezone !== 'Europe/Moscow') {
		throw new BadRequestException(
			'timezone must remain Europe/Moscow while backups use Moscow time'
		);
	}
	if (
		config.destinationChatId !== null &&
		(!config.destinationChatId.trim() ||
			config.destinationChatId.length > 255)
	) {
		throw new BadRequestException('destinationChatId is invalid');
	}
	if (
		config.messageThreadId !== null &&
		(!Number.isInteger(config.messageThreadId) ||
			config.messageThreadId < 1)
	) {
		throw new BadRequestException('messageThreadId is invalid');
	}
	if (
		config.enabled &&
		(!config.destinationChatId ||
			config.messageThreadId === null ||
			!config.coreOperationalAlertsDestinationChatId ||
			config.coreOperationalAlertsThreadId === null)
	) {
		throw new BadRequestException(
			'Enabled Daily Summary requires complete Daily Summary and Core operational alerts routes'
		);
	}
	if (
		config.destinationChatId !== null &&
		config.destinationChatId ===
			config.coreOperationalAlertsDestinationChatId &&
		config.messageThreadId !== null &&
		config.messageThreadId === config.coreOperationalAlertsThreadId
	) {
		throw new BadRequestException(
			'Daily Summary and Core operational alerts require separate Telegram topics'
		);
	}
}

export function getDailySummarySettingsUpdateKind(
	dto: UpdateDailySummarySettingsDto
): 'local' | 'schedule' {
	const hasLocalFields =
		dto.enabled !== undefined ||
		dto.destinationChatId !== undefined ||
		dto.messageThreadId !== undefined;
	const hasScheduleTime = dto.scheduleTime !== undefined;
	const hasExpectedGeneration =
		dto.expectedScheduleGeneration !== undefined;
	if (!hasLocalFields && !hasScheduleTime && !hasExpectedGeneration) {
		throw new BadRequestException(
			'Daily Summary settings update cannot be empty'
		);
	}
	if (hasScheduleTime !== hasExpectedGeneration) {
		throw new BadRequestException(
			'scheduleTime and expectedScheduleGeneration are required together'
		);
	}
	return hasScheduleTime ? 'schedule' : 'local';
}

@Injectable()
export class DailySummarySettingsService {
	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly core: CoreInternalClient
	) {}

	async getSettings() {
		const settings = await this.prisma.reportingSettings.upsert({
			where: { id: 'daily-summary' },
			create: { id: 'daily-summary' },
			update: {}
		});
		return this.toResponse(settings);
	}

	async getSchedulerSettings(): Promise<ReportingSettings> {
		return this.prisma.reportingSettings.upsert({
			where: { id: 'daily-summary' },
			create: { id: 'daily-summary' },
			update: {}
		});
	}

	async updateSettings(
		dto: UpdateDailySummarySettingsDto,
		actorId: string
	) {
		const updateKind = getDailySummarySettingsUpdateKind(dto);
		let currentSettings = await this.prisma.reportingSettings.findUnique({
			where: { id: 'daily-summary' }
		});
		if (currentSettings?.owner !== ReportingOwner.REPORTING) {
			throw new ConflictException(
				'Daily Summary settings are not owned by Reporting yet'
			);
		}
		if (currentSettings.schedulePolicyChangeId) {
			currentSettings =
				await this.confirmPendingPolicyReservation(currentSettings);
		}
		const expectedScheduleGeneration =
			updateKind === 'schedule'
				? BigInt(dto.expectedScheduleGeneration!)
				: undefined;
		if (
			expectedScheduleGeneration !== undefined &&
			currentSettings.scheduleGeneration !== expectedScheduleGeneration
		) {
			if (
				currentSettings.scheduleGeneration ===
					expectedScheduleGeneration + 1n &&
				currentSettings.scheduleTime === dto.scheduleTime &&
				this.matchesRequestedSettings(currentSettings, dto)
			) {
				return this.toResponse(currentSettings);
			}
			throw new ConflictException(
				'Daily Summary settings changed; reload settings'
			);
		}
		validateDailySummarySettingsConfig(
			this.mergeFinalConfig(currentSettings, dto)
		);

		let policyReservationAccepted = false;
		let reservationGeneration = expectedScheduleGeneration;
		let policyChangeId: string | null = null;
		const scheduleChanged =
			updateKind === 'schedule' &&
			dto.scheduleTime !== currentSettings.scheduleTime;
		if (scheduleChanged) {
			policyChangeId = this.createPolicyChangeId(
				dto.scheduleTime!,
				dto.expectedScheduleGeneration!
			);
			const reservation =
				await this.core.reserveDailySummarySchedulePolicy(
					policyChangeId,
					dto.scheduleTime!,
					dto.expectedScheduleGeneration!,
					actorId
				);
			reservationGeneration = BigInt(reservation.reservationGeneration);
			if (
				reservation.changeId !== policyChangeId ||
				!reservation.confirmationRequired
			) {
				throw new ServiceUnavailableException(
					'Core returned an invalid backup-policy reservation state'
				);
			}
			policyReservationAccepted = true;
		}
		let updated: ReportingSettings;
		try {
			updated = await this.prisma.$transaction(async transaction => {
				await transaction.reportingSettings.upsert({
					where: { id: 'daily-summary' },
					create: { id: 'daily-summary' },
					update: {}
				});
				const lockedRows = await transaction.$queryRaw<
					Array<{ id: string }>
				>(
					Prisma.sql`
						SELECT "id"
						FROM reporting."reporting_settings"
						WHERE "id" = 'daily-summary'
						FOR UPDATE
					`
				);
				if (lockedRows.length !== 1) {
					throw new Error('Daily Summary settings row is missing');
				}
				const current =
					await transaction.reportingSettings.findUniqueOrThrow({
						where: { id: 'daily-summary' }
					});
				if (current.owner !== ReportingOwner.REPORTING) {
					throw new ConflictException(
						'Daily Summary settings are not owned by Reporting yet'
					);
				}
				if (
					expectedScheduleGeneration !== undefined &&
					current.scheduleGeneration !== expectedScheduleGeneration
				) {
					if (
						current.scheduleGeneration ===
							expectedScheduleGeneration + 1n &&
						current.scheduleTime === dto.scheduleTime &&
						this.matchesRequestedSettings(current, dto)
					) {
						return current;
					}
					throw new ConflictException(
						'Daily Summary settings changed; reload settings'
					);
				}
				const finalConfig = this.mergeFinalConfig(current, dto);
				validateDailySummarySettingsConfig(finalConfig);
				const scheduleChangedInTransaction =
					finalConfig.scheduleTime !== current.scheduleTime;
				const nextScheduleGeneration = scheduleChangedInTransaction
					? current.scheduleGeneration + 1n
					: current.scheduleGeneration;
				if (
					scheduleChangedInTransaction &&
					reservationGeneration !== nextScheduleGeneration
				) {
					throw new Error(
						'Core backup-policy reservation does not match the local Reporting CAS generation'
					);
				}
				const changedFields = REPORTING_SETTINGS_AUDIT_FIELDS.filter(
					field => current[field] !== finalConfig[field]
				).sort() as ReportingSettingsAuditField[];
				if (!changedFields.length) return current;
				const settings = await transaction.reportingSettings.update({
					where: { id: current.id },
					data: {
						enabled: finalConfig.enabled,
						destinationChatId: finalConfig.destinationChatId,
						messageThreadId: finalConfig.messageThreadId,
						scheduleTime: finalConfig.scheduleTime,
						timezone: finalConfig.timezone,
						scheduleGeneration: nextScheduleGeneration,
						schedulePolicyChangeId: scheduleChangedInTransaction
							? policyChangeId
							: current.schedulePolicyChangeId
					}
				});
				const eventId = randomUUID();
				const correlationId = createReportingCorrelationId();
				const payload: ReportingSettingsAdminAuditEvent = {
					schemaVersion: 1,
					eventType: ADMIN_AUDIT_EVENT_TYPE,
					eventId,
					occurredAt: new Date().toISOString(),
					correlationId,
					actorId,
					action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
					target: { reportingSettingsId: 'daily-summary' },
					metadata: { changedFields }
				};
				assertReportingAdminAuditEvent(payload, eventId);
				await transaction.reportingOutboxEvent.create({
					data: {
						messageId: eventId,
						deduplicationKey: `reporting-settings-audit:${eventId}`,
						exchange: ReportingOutboxExchange.EVENTS,
						eventType: ADMIN_AUDIT_EVENT_TYPE,
						routingKey: REPORTING_ADMIN_AUDIT_ROUTING_KEY,
						payload: payload as unknown as Prisma.InputJsonObject,
						headers: {
							'x-correlation-id': correlationId,
							'x-causation-id': eventId
						},
						status: ReportingOutboxStatus.PENDING
					}
				});
				return settings;
			});
		} catch (error) {
			if (!policyReservationAccepted) {
				throw error;
			}
			throw new ServiceUnavailableException({
				code: 'SCHEDULE_POLICY_RESERVED_RETRY_REQUIRED',
				message:
					'Core reserved the backup-policy fence, but Reporting settings were not committed; retry the same request'
			});
		}
		if (policyChangeId) {
			try {
				await this.core.confirmDailySummarySchedulePolicy(
					policyChangeId,
					updated.scheduleGeneration.toString()
				);
				const cleared = await this.prisma.reportingSettings.updateMany({
					where: {
						id: 'daily-summary',
						scheduleGeneration: updated.scheduleGeneration,
						schedulePolicyChangeId: policyChangeId
					},
					data: { schedulePolicyChangeId: null }
				});
				if (cleared.count !== 1) {
					const concurrent =
						await this.prisma.reportingSettings.findUniqueOrThrow({
							where: { id: 'daily-summary' }
						});
					if (
						concurrent.scheduleGeneration !== updated.scheduleGeneration ||
						concurrent.schedulePolicyChangeId !== null
					) {
						throw new Error(
							'Reporting policy confirmation marker changed concurrently'
						);
					}
				}
				updated = await this.prisma.reportingSettings.findUniqueOrThrow({
					where: { id: 'daily-summary' }
				});
			} catch {
				throw new ServiceUnavailableException({
					code: 'SCHEDULE_POLICY_CONFIRMATION_PENDING',
					message:
						'Reporting settings were committed, but the Core backup-policy confirmation is pending; retry the same settings save'
				});
			}
		}
		return this.toResponse(updated);
	}

	private async confirmPendingPolicyReservation(
		current: ReportingSettings
	): Promise<ReportingSettings> {
		const changeId = current.schedulePolicyChangeId;
		if (!changeId) return current;
		try {
			const confirmation =
				await this.core.confirmDailySummarySchedulePolicy(
					changeId,
					current.scheduleGeneration.toString()
				);
			if (
				confirmation.changeId !== changeId ||
				confirmation.reservationGeneration !==
					current.scheduleGeneration.toString()
			) {
				throw new Error('Core returned an invalid policy confirmation');
			}
			await this.prisma.reportingSettings.updateMany({
				where: {
					id: current.id,
					scheduleGeneration: current.scheduleGeneration,
					schedulePolicyChangeId: changeId
				},
				data: { schedulePolicyChangeId: null }
			});
			return this.prisma.reportingSettings.findUniqueOrThrow({
				where: { id: current.id }
			});
		} catch {
			throw new ServiceUnavailableException({
				code: 'SCHEDULE_POLICY_CONFIRMATION_PENDING',
				message:
					'A previous Core backup-policy reservation is still pending confirmation; retry this save later'
			});
		}
	}

	private createPolicyChangeId(
		scheduleTime: string,
		expectedScheduleGeneration: string
	): string {
		const bytes = Buffer.from(
			createHash('sha256')
				.update(
					`reporting.daily-summary.policy.v1\0${expectedScheduleGeneration}\0${scheduleTime}`
				)
				.digest()
				.subarray(0, 16)
		);
		bytes[6] = (bytes[6] & 0x0f) | 0x50;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = bytes.toString('hex');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}

	private mergeFinalConfig(
		current: ReportingSettings,
		dto: UpdateDailySummarySettingsDto
	): FinalDailySummaryConfig {
		return {
			enabled: dto.enabled ?? current.enabled,
			destinationChatId:
				dto.destinationChatId !== undefined
					? dto.destinationChatId?.trim() || null
					: current.destinationChatId,
			messageThreadId:
				dto.messageThreadId !== undefined
					? dto.messageThreadId
					: current.messageThreadId,
			coreOperationalAlertsThreadId: current.coreOperationalAlertsThreadId,
			coreOperationalAlertsDestinationChatId:
				current.coreOperationalAlertsDestinationChatId,
			scheduleTime: dto.scheduleTime ?? current.scheduleTime,
			timezone: current.timezone
		};
	}

	private matchesRequestedSettings(
		current: ReportingSettings,
		dto: UpdateDailySummarySettingsDto
	): boolean {
		const requested = this.mergeFinalConfig(current, dto);
		return REPORTING_SETTINGS_AUDIT_FIELDS.every(
			field => current[field] === requested[field]
		);
	}

	private toResponse(settings: ReportingSettings) {
		return {
			id: settings.id,
			owner: settings.owner,
			enabled: settings.enabled,
			destinationChatId: settings.destinationChatId,
			messageThreadId: settings.messageThreadId,
			coreOperationalAlertsThreadId:
				settings.coreOperationalAlertsThreadId,
			coreOperationalAlertsDestinationChatId:
				settings.coreOperationalAlertsDestinationChatId,
			scheduleTime: settings.scheduleTime,
			timezone: settings.timezone,
			scheduleGeneration: settings.scheduleGeneration.toString(),
			schedulePolicyConfirmationPending: Boolean(
				settings.schedulePolicyChangeId
			),
			lastSuccessfulDelivery:
				settings.lastSuccessfulAt && settings.lastSuccessfulPeriodStart
					? {
							periodStart:
								settings.lastSuccessfulPeriodStart.toISOString(),
							completedAt: settings.lastSuccessfulAt.toISOString()
						}
					: null,
			lastFailedDelivery:
				settings.lastFailedAt && settings.lastFailedPeriodStart
					? {
							periodStart: settings.lastFailedPeriodStart.toISOString(),
							failedAt: settings.lastFailedAt.toISOString(),
							code: settings.lastFailureCode,
							safeReason: settings.lastFailureReason
						}
					: null,
			updatedAt: settings.updatedAt.toISOString()
		};
	}
}
