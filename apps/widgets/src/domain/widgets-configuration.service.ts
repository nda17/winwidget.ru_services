import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { EntitlementPlan, Prisma } from '@prisma/widgets-client';
import { randomBytes } from 'node:crypto';
import {
	WidgetsAuditInput,
	WidgetsDomainEventsService
} from '../messaging/widgets-domain-events.service';
import { WidgetsQuotaService } from '../quota/widgets-quota.service';
import { WidgetsSafeHttpService } from '../integrations/widgets-safe-http.service';
import { WidgetsAccessService } from './widgets-access.service';
import { WidgetsDomainRepository } from './widgets-domain.repository';
import {
	asJsonObject,
	assertExpectedDraftRevision,
	getDraftConfig,
	getWidgetDefinition,
	projectWidgetDraft,
	WidgetEntity,
	WidgetType
} from './widgets-domain.types';
import {
	normalizeWidgetConfig,
	prepareWidgetConfigPatch
} from './widgets-config-normalizer';
import { normalizeInstallDomain } from './widgets-domain.util';
import { WidgetsImageLifecycleService } from './widgets-image-lifecycle.service';
import {
	WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES,
	WidgetsImageService
} from './widgets-image.service';
import { WidgetsReportingService } from './widgets-reporting.service';

export { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES };

const TX_OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 5_000,
	timeout: 15_000
} as const;

export interface WidgetUpdateInput {
	expectedDraftRevision?: number;
	name?: string;
	isActive?: boolean;
	installDomain?: string;
	config?: Record<string, unknown>;
}

@Injectable()
export class WidgetsConfigurationService {
	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly access: WidgetsAccessService,
		private readonly quota: WidgetsQuotaService,
		private readonly reporting: WidgetsReportingService,
		private readonly events: WidgetsDomainEventsService,
		private readonly images: WidgetsImageService,
		private readonly imageLifecycle: WidgetsImageLifecycleService,
		private readonly safeHttp: WidgetsSafeHttpService
	) {}

	async list(type: WidgetType, userId: string) {
		const [entities, snapshot] = await Promise.all([
			this.repository.findManyForOwner(type, userId),
			this.quota.readSnapshot(userId)
		]);
		const entitlement = snapshot.entitlement;
		const subscription =
			entitlement &&
			!entitlement.tombstoned &&
			entitlement.plan !== null &&
			entitlement.status !== null &&
			entitlement.startsAt !== null &&
			entitlement.sourceCreatedAt !== null
				? {
						id: entitlement.id,
						userId: entitlement.userId,
						plan: entitlement.plan,
						billingPeriod: entitlement.billingPeriod,
						status: entitlement.status,
						startsAt: entitlement.startsAt,
						expiresAt: entitlement.expiresAt,
						periodResetsAt: entitlement.periodResetsAt,
						maxWidgets: entitlement.maxWidgets,
						maxLeadsPerPeriod: entitlement.maxLeadsPerPeriod,
						unlimited: entitlement.unlimited,
						leadsThisPeriod: snapshot.counter?.leadCount ?? 0,
						createdAt: entitlement.sourceCreatedAt,
						updatedAt: entitlement.sourceOccurredAt
					}
				: null;
		return {
			[getWidgetDefinition(type).responseCollection]:
				entities.map(projectWidgetDraft),
			subscription
		};
	}

	async create(
		type: WidgetType,
		userId: string,
		name: string | undefined,
		correlationId: string
	): Promise<WidgetEntity> {
		const definition = getWidgetDefinition(type);
		const config = definition.defaultConfig();
		return this.quota.withWidgetCreation(
			userId,
			{
				idempotencyKey: `widget-create:${userId}:${correlationId}`,
				correlationId
			},
			async transaction => {
				const widget = await this.repository.create(type, transaction, {
					userId,
					publicKey: randomBytes(6).toString('hex'),
					name: name?.trim() || definition.defaultName,
					config,
					draftConfig: config,
					draftInstallDomain: '',
					draftRevision: 1
				});
				await this.reporting.enqueueWidget(
					transaction,
					type,
					widget,
					false,
					correlationId
				);
				return {
					value: widget,
					aggregateType: this.reporting.widgetAggregateType(type),
					aggregateId: this.reporting.aggregateId(type, widget.id)
				};
			}
		);
	}

	async update(
		type: WidgetType,
		widgetId: string,
		userId: string,
		dto: WidgetUpdateInput,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		const changedFields = Object.keys(dto)
			.filter(
				key =>
					key !== 'expectedDraftRevision' &&
					dto[key as keyof WidgetUpdateInput] !== undefined
			)
			.sort();
		if (!changedFields.length)
			throw new BadRequestException('Нет изменений');
		let previousImage: unknown;
		const result = await this.repository
			.client()
			.$transaction(async transaction => {
				await this.access.assertOwnerCanModify(
					transaction,
					userId,
					Boolean(audit),
					dto.isActive === true
				);
				const current = await this.access.owned(
					type,
					widgetId,
					userId,
					transaction
				);
				const draftChanged =
					dto.config !== undefined || dto.installDomain !== undefined;
				if (draftChanged)
					assertExpectedDraftRevision(current, dto.expectedDraftRevision);
				const currentConfig = asJsonObject(getDraftConfig(current));
				previousImage = currentConfig.buttonImageUrl;
				let nextConfig: Prisma.InputJsonObject | undefined;
				if (dto.config !== undefined) {
					const patch = prepareWidgetConfigPatch(type, dto.config);
					if (Object.hasOwn(patch, 'buttonImageUrl')) {
						const currentUrl =
							typeof currentConfig.buttonImageUrl === 'string'
								? currentConfig.buttonImageUrl
								: '';
						const requested =
							typeof patch.buttonImageUrl === 'string'
								? patch.buttonImageUrl
								: '';
						if (requested && requested !== currentUrl) {
							throw new BadRequestException(
								'Картинку кнопки нужно загружать через отдельное поле загрузки'
							);
						}
					}
					nextConfig = normalizeWidgetConfig(type, {
						...currentConfig,
						...patch,
						integrations: {
							...asJsonObject(currentConfig.integrations),
							...asJsonObject(patch.integrations)
						}
					});
					await this.safeHttp.validateIntegrationConfig(
						asJsonObject(nextConfig.integrations)
					);
				}
				const count = await this.repository.updateMany(
					type,
					transaction,
					{
						id: widgetId,
						userId,
						...(draftChanged && {
							draftRevision: dto.expectedDraftRevision
						})
					},
					{
						...(dto.name !== undefined && { name: dto.name.trim() }),
						...(dto.isActive !== undefined && { isActive: dto.isActive }),
						...(dto.installDomain !== undefined && {
							draftInstallDomain: normalizeInstallDomain(dto.installDomain)
						}),
						...(nextConfig && { draftConfig: nextConfig }),
						...(draftChanged && { draftRevision: { increment: 1 } })
					}
				);
				if (count !== 1) {
					throw new ConflictException(
						'Настройки уже изменены в другой сессии. Обновите страницу'
					);
				}
				const updated = await this.access.require(
					type,
					widgetId,
					transaction
				);
				if (
					dto.isActive !== undefined &&
					dto.isActive !== current.isActive
				) {
					await this.reporting.enqueueWidget(
						transaction,
						type,
						updated,
						false,
						correlationId
					);
				}
				if (audit) {
					await this.events.enqueueAdminAudit(transaction, {
						action: 'WIDGET_UPDATE',
						actorId: audit.actorId,
						correlationId,
						widget: updated,
						widgetType: type,
						metadata: { changedFields }
					});
				}
				return projectWidgetDraft(updated);
			}, TX_OPTIONS);
		await this.imageLifecycle.cleanupIfUnreferenced(
			type,
			widgetId,
			previousImage
		);
		return result;
	}

	async delete(
		type: WidgetType,
		widgetId: string,
		userId: string,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		const imageUrls: string[] = [];
		const deleted = await this.quota.withWidgetDeletion(
			userId,
			{
				idempotencyKey: `widget-delete:${type}:${widgetId}`,
				correlationId
			},
			async transaction => {
				await this.access.assertOwnerCanModify(
					transaction,
					userId,
					Boolean(audit)
				);
				const widget = await this.access.owned(
					type,
					widgetId,
					userId,
					transaction
				);
				const revisions = await transaction.widgetConfigRevision.findMany({
					where: { widgetType: type, widgetId },
					select: { config: true }
				});
				for (const config of [
					widget.config,
					widget.draftConfig,
					...revisions.map(item => item.config)
				]) {
					const url = asJsonObject(config).buttonImageUrl;
					if (this.images.isManaged(url)) imageUrls.push(url);
				}
				await Promise.all([
					transaction.widgetConfigRevision.deleteMany({
						where: { widgetType: type, widgetId }
					}),
					transaction.widgetRuntimeDailyStepMetric.deleteMany({
						where: { widgetType: type, widgetId }
					}),
					transaction.widgetRuntimeDailyMetric.deleteMany({
						where: { widgetType: type, widgetId }
					}),
					transaction.widgetRuntimePresence.deleteMany({
						where: { widgetType: type, widgetId }
					})
				]);
				const removedLeads = await this.repository.allLeadsInTransaction(
					type,
					widgetId,
					transaction
				);
				for (const lead of removedLeads) {
					await this.reporting.enqueueLead(
						transaction,
						type,
						widgetId,
						lead,
						true,
						correlationId
					);
				}
				const removed = await this.repository.delete(
					type,
					widgetId,
					transaction
				);
				await this.reporting.enqueueWidget(
					transaction,
					type,
					removed,
					true,
					correlationId
				);
				if (audit) {
					await this.events.enqueueAdminAudit(transaction, {
						action: 'WIDGET_DELETE',
						actorId: audit.actorId,
						correlationId,
						widget: removed,
						widgetType: type,
						metadata: {}
					});
				}
				return {
					value: removed,
					aggregateType: this.reporting.widgetAggregateType(type),
					aggregateId: this.reporting.aggregateId(type, widgetId)
				};
			}
		);
		await Promise.all(
			[...new Set(imageUrls)].map(url =>
				this.images.delete(url).catch(() => undefined)
			)
		);
		return deleted;
	}

	async uploadImage(
		type: WidgetType,
		widgetId: string,
		userId: string,
		file: Express.Multer.File | undefined,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		if (type === WidgetType.STOP_OFFER) {
			throw new BadRequestException(
				'Загрузка изображения не поддерживается для этого виджета'
			);
		}
		const snapshot = await this.quota.snapshot(userId);
		if (snapshot.entitlement.plan !== EntitlementPlan.HARD) {
			throw new ForbiddenException(
				'Загрузка своей картинки кнопки доступна только на тарифе Hard'
			);
		}
		const widget = await this.access.owned(type, widgetId, userId);
		assertExpectedDraftRevision(widget, expectedDraftRevision);
		const uploaded = await this.images.save(
			file,
			getWidgetDefinition(type).slug,
			widgetId
		);
		const previousImage = asJsonObject(
			getDraftConfig(widget)
		).buttonImageUrl;
		try {
			const result = await this.repository
				.client()
				.$transaction(async transaction => {
					await this.access.assertOwnerCanModify(
						transaction,
						userId,
						Boolean(audit)
					);
					const current = await this.access.owned(
						type,
						widgetId,
						userId,
						transaction
					);
					assertExpectedDraftRevision(current, expectedDraftRevision);
					const config = normalizeWidgetConfig(type, {
						...asJsonObject(getDraftConfig(current)),
						buttonImageUrl: uploaded
					});
					const count = await this.repository.updateMany(
						type,
						transaction,
						{
							id: widgetId,
							userId,
							draftRevision: expectedDraftRevision
						},
						{ draftConfig: config, draftRevision: { increment: 1 } }
					);
					if (count !== 1) {
						throw new ConflictException(
							'Настройки уже изменены в другой сессии. Обновите страницу'
						);
					}
					const updated = await this.access.require(
						type,
						widgetId,
						transaction
					);
					if (audit) {
						await this.events.enqueueAdminAudit(transaction, {
							action: 'WIDGET_BUTTON_IMAGE_UPDATE',
							actorId: audit.actorId,
							correlationId,
							widget: updated,
							widgetType: type,
							metadata: { imagePresent: true }
						});
					}
					return projectWidgetDraft(updated);
				}, TX_OPTIONS);
			await this.imageLifecycle.cleanupIfUnreferenced(
				type,
				widgetId,
				previousImage
			);
			return result;
		} catch (error) {
			await this.images.delete(uploaded).catch(() => undefined);
			throw error;
		}
	}
}
