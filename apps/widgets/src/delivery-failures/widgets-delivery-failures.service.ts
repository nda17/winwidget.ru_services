import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	IntegrationDeliveryFailure,
	IntegrationDeliveryReceiptStatus,
	IntegrationErrorCategory,
	IntegrationFailureResolution,
	Prisma,
	WidgetsOutboxExchange,
	WidgetsOutboxStatus
} from '@prisma/widgets-client';
import { createHash, randomUUID } from 'node:crypto';
import { WidgetsDomainRepository } from '../domain/widgets-domain.repository';
import {
	asJsonObject,
	parseWidgetType
} from '../domain/widgets-domain.types';
import { WidgetsIntegrationDeliveryService } from '../integrations/widgets-integration-delivery.service';
import { WidgetsDomainEventsService } from '../messaging/widgets-domain-events.service';
import {
	getWidgetsManualRetryRoutingKey,
	WIDGETS_PROVIDER_KINDS,
	WidgetsProviderKind
} from '../messaging/widgets-messaging.constants';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';

const MAX_MANUAL_RETRY_CYCLES = 1_000_000;
const MANUAL_RETRY_LEASE_MS = 60 * 60_000;

interface FailureFilters {
	integration?: string;
	category?: string;
	status?: string;
}

@Injectable()
export class WidgetsDeliveryFailuresService {
	constructor(
		private readonly prisma: WidgetsPrismaService,
		private readonly repository: WidgetsDomainRepository,
		private readonly delivery: WidgetsIntegrationDeliveryService,
		private readonly events: WidgetsDomainEventsService
	) {}

	async list(page: number, limit: number, filters: FailureFilters) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = this.where(filters);
		const [items, total] = await this.prisma.$transaction([
			this.prisma.integrationDeliveryFailure.findMany({
				where,
				orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit
			}),
			this.prisma.integrationDeliveryFailure.count({ where })
		]);
		return {
			items: items.map(item => this.serialize(item)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async get(id: string) {
		const failure =
			await this.prisma.integrationDeliveryFailure.findUnique({
				where: { id }
			});
		if (!failure)
			throw new NotFoundException('Ошибка доставки не найдена');
		return this.serialize(failure);
	}

	async retry(id: string, actorId: string, correlationId: string) {
		const now = new Date();
		const leaseExpiresAt = new Date(now.getTime() + MANUAL_RETRY_LEASE_MS);
		return this.prisma.$transaction(async transaction => {
			const context = await this.context(transaction, id);
			const { failure, kind, event, widget, widgetType } = context;
			if (failure.resolvedAt)
				throw new ConflictException('Ошибка уже обработана');
			if (failure.manualRetryCount >= MAX_MANUAL_RETRY_CYCLES) {
				throw new ConflictException('Лимит ручных повторов исчерпан');
			}
			const currentDestination = this.events.credentialForConfig(
				widgetType,
				widget.config,
				kind
			);
			if (!currentDestination) {
				throw new ConflictException('Интеграция больше не настроена');
			}
			const credentialRef = String(
				asJsonObject(event.destination).credentialRef || ''
			);
			const snapshot =
				await transaction.integrationCredentialSnapshot.findUnique({
					where: { id: credentialRef }
				});
			if (
				!snapshot ||
				snapshot.eventId !== failure.eventId ||
				snapshot.integration !== kind ||
				snapshot.source !== String(event.source) ||
				snapshot.entityId !== widget.id
			) {
				throw new ConflictException(
					'Снимок настроек интеграции не соответствует событию'
				);
			}
			if (
				snapshot.targetFingerprint !== currentDestination.targetFingerprint
			) {
				throw new ConflictException(
					'Адрес назначения изменился. Закройте старую ошибку без повтора'
				);
			}
			const payloadHash = this.payloadHash(event);
			const receipt =
				await transaction.integrationDeliveryReceipt.findUnique({
					where: {
						eventId_integration: {
							eventId: failure.eventId,
							integration: kind
						}
					}
				});
			if (
				!receipt ||
				receipt.status !==
					IntegrationDeliveryReceiptStatus.DEAD_LETTERED ||
				receipt.payloadHash !== payloadHash ||
				receipt.retryCycle !== failure.manualRetryCount
			) {
				throw new ConflictException(
					'Событие уже доставляется или было обработано'
				);
			}
			const retryCycle = failure.manualRetryCount + 1;
			const retryToken = randomUUID();
			const claimed =
				await transaction.integrationDeliveryFailure.updateMany({
					where: {
						id: failure.id,
						resolvedAt: null,
						manualRetryCount: failure.manualRetryCount,
						OR: [
							{ activeRetryToken: null },
							{ retryLeaseExpiresAt: { lte: now } }
						]
					},
					data: {
						retryingAt: now,
						activeRetryToken: retryToken,
						retryLeaseExpiresAt: leaseExpiresAt,
						manualRetryCount: retryCycle
					}
				});
			if (claimed.count !== 1) {
				throw new ConflictException('Повторная отправка уже выполняется');
			}
			const receiptUpdated =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						id: receipt.id,
						status: IntegrationDeliveryReceiptStatus.DEAD_LETTERED,
						payloadHash,
						retryCycle: failure.manualRetryCount
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
						retryAttempt: 0,
						retryCycle,
						retryAvailableAt: now,
						retryToken,
						deliveredAt: null,
						lastError: null
					}
				});
			if (receiptUpdated.count !== 1) {
				throw new ConflictException(
					'Состояние доставки изменилось параллельно'
				);
			}
			await transaction.integrationCredentialSnapshot.update({
				where: { id: snapshot.id },
				data: {
					credentials: currentDestination.credentials,
					version: { increment: 1 }
				}
			});
			await transaction.widgetsOutboxEvent.create({
				data: {
					messageId: failure.eventId,
					deduplicationKey: `integration-manual-retry:${kind}:${failure.eventId}:${retryCycle}`,
					exchange: WidgetsOutboxExchange.MANUAL_RETRY,
					eventType: 'lead.integration.requested.v2',
					routingKey: getWidgetsManualRetryRoutingKey(kind),
					payload: event as unknown as Prisma.InputJsonValue,
					headers: {
						'x-correlation-id': correlationId,
						'x-causation-id': failure.eventId,
						'x-retry-attempt': 0,
						'x-manual-retry-cycle': retryCycle,
						'x-delivery-token': retryToken,
						'x-manual-retry': true
					},
					status: WidgetsOutboxStatus.PENDING
				}
			});
			await this.events.enqueueAdminAudit(transaction, {
				action: 'WIDGET_DELIVERY_RETRY',
				actorId,
				correlationId,
				widget,
				widgetType,
				targetExtra: { failureId: failure.id, integration: kind },
				metadata: {}
			});
			return {
				id: failure.id,
				eventId: failure.eventId,
				integration: kind,
				retryingAt: now.toISOString(),
				manualRetryCount: retryCycle
			};
		});
	}

	async close(
		id: string,
		actorId: string,
		comment: string,
		correlationId: string
	) {
		const normalizedComment = comment.trim();
		if (normalizedComment.length < 3 || normalizedComment.length > 1_000) {
			throw new BadRequestException(
				'Комментарий должен содержать от 3 до 1000 символов'
			);
		}
		const resolvedAt = new Date();
		return this.prisma.$transaction(async transaction => {
			const { failure, kind, event, widget, widgetType } =
				await this.context(transaction, id);
			if (failure.resolvedAt)
				throw new ConflictException('Ошибка уже обработана');
			if (
				failure.activeRetryToken &&
				failure.retryLeaseExpiresAt &&
				failure.retryLeaseExpiresAt > resolvedAt
			) {
				throw new ConflictException(
					'Нельзя закрыть ошибку во время повторной отправки'
				);
			}
			const payloadHash = this.payloadHash(event);
			const receipt =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId: failure.eventId,
						integration: kind,
						status: IntegrationDeliveryReceiptStatus.DEAD_LETTERED,
						payloadHash
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY,
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null,
						lastError: null
					}
				});
			if (receipt.count !== 1) {
				throw new ConflictException(
					'Событие уже доставляется или было обработано'
				);
			}
			const closed =
				await transaction.integrationDeliveryFailure.updateMany({
					where: { id: failure.id, resolvedAt: null },
					data: {
						resolvedAt,
						resolution: IntegrationFailureResolution.CLOSED_NO_RETRY,
						resolutionComment: normalizedComment,
						resolvedById: actorId,
						retryingAt: null,
						activeRetryToken: null,
						retryLeaseExpiresAt: null
					}
				});
			if (closed.count !== 1)
				throw new ConflictException('Ошибка уже обработана');
			await transaction.integrationCredentialSnapshot.deleteMany({
				where: { eventId: failure.eventId, integration: kind }
			});
			await this.events.enqueueAdminAudit(transaction, {
				action: 'WIDGET_DELIVERY_CLOSE',
				actorId,
				correlationId,
				widget,
				widgetType,
				targetExtra: { failureId: failure.id, integration: kind },
				metadata: {
					commentPresent: true,
					commentLength: normalizedComment.length
				}
			});
			return {
				id: failure.id,
				eventId: failure.eventId,
				integration: kind,
				resolvedAt: resolvedAt.toISOString(),
				resolution: IntegrationFailureResolution.CLOSED_NO_RETRY,
				resolutionComment: normalizedComment
			};
		});
	}

	private async context(
		transaction: Prisma.TransactionClient,
		id: string
	) {
		const failure =
			await transaction.integrationDeliveryFailure.findUnique({
				where: { id }
			});
		if (!failure)
			throw new NotFoundException('Ошибка доставки не найдена');
		const kind = this.kind(failure.integration);
		let event: ReturnType<WidgetsIntegrationDeliveryService['parse']>;
		try {
			event = this.delivery.parse(failure.payload, kind);
		} catch {
			throw new ConflictException(
				'Событие ошибки имеет некорректный контракт'
			);
		}
		const widgetType = parseWidgetType(event.source);
		const widget = await this.repository.findById(
			widgetType,
			event.entity.id,
			transaction
		);
		if (!widget)
			throw new ConflictException('Виджет события больше не существует');
		return { failure, kind, event, widget, widgetType };
	}

	private kind(value: string): WidgetsProviderKind {
		if (!WIDGETS_PROVIDER_KINDS.includes(value as WidgetsProviderKind)) {
			throw new BadRequestException('Некорректный тип интеграции');
		}
		return value as WidgetsProviderKind;
	}

	private where(
		filters: FailureFilters
	): Prisma.IntegrationDeliveryFailureWhereInput {
		const where: Prisma.IntegrationDeliveryFailureWhereInput = {};
		if (filters.integration?.trim())
			where.integration = this.kind(filters.integration.trim());
		const category = filters.category?.trim().toUpperCase();
		if (category) {
			if (
				!Object.values(IntegrationErrorCategory).includes(
					category as IntegrationErrorCategory
				)
			) {
				throw new BadRequestException(
					'Некорректная категория ошибки доставки'
				);
			}
			where.category = category as IntegrationErrorCategory;
		}
		const status = filters.status?.trim().toUpperCase();
		if (status === 'FAILED') {
			where.resolvedAt = null;
			where.retryingAt = null;
		} else if (status === 'RETRYING') {
			where.resolvedAt = null;
			where.retryingAt = { not: null };
		} else if (status === 'RESOLVED') {
			where.resolution = IntegrationFailureResolution.DELIVERED;
		} else if (status === 'CLOSED') {
			where.resolution = IntegrationFailureResolution.CLOSED_NO_RETRY;
		} else if (status && status !== 'ALL') {
			throw new BadRequestException('Некорректный статус ошибки доставки');
		}
		return where;
	}

	private serialize(item: IntegrationDeliveryFailure) {
		const payload = asJsonObject(item.payload);
		const lead = asJsonObject(payload.lead);
		return {
			id: item.id,
			eventId: item.eventId,
			integration: item.integration,
			attempts: item.attempts,
			lastError: item.lastError,
			category: item.category,
			normalizedCode: item.normalizedCode,
			safeReason: item.safeReason,
			httpStatus: item.httpStatus,
			providerCode: item.providerCode,
			retryable: item.retryable,
			failedAt: item.failedAt.toISOString(),
			retryingAt: item.retryingAt?.toISOString() || null,
			resolvedAt: item.resolvedAt?.toISOString() || null,
			resolution: item.resolution,
			resolutionComment: item.resolutionComment,
			source: typeof payload.source === 'string' ? payload.source : null,
			entity: asJsonObject(payload.entity),
			lead: {
				id: typeof lead.id === 'string' ? lead.id : null,
				contact: typeof lead.contact === 'string' ? lead.contact : null,
				phone: typeof lead.phone === 'string' ? lead.phone : null,
				email: typeof lead.email === 'string' ? lead.email : null,
				url: typeof lead.url === 'string' ? lead.url : null,
				createdAt:
					typeof lead.createdAt === 'string' ? lead.createdAt : null
			}
		};
	}

	private payloadHash(value: unknown): string {
		return createHash('sha256')
			.update(this.canonical(value))
			.digest('hex');
	}

	private canonical(value: unknown): string {
		if (value === null || typeof value !== 'object')
			return JSON.stringify(value);
		if (Array.isArray(value))
			return `[${value.map(item => this.canonical(item)).join(',')}]`;
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${this.canonical(record[key])}`)
			.join(',')}}`;
	}
}
