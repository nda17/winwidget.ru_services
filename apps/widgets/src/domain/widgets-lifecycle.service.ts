import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import { randomBytes } from 'node:crypto';
import {
	WidgetsAuditInput,
	WidgetsDomainEventsService
} from '../messaging/widgets-domain-events.service';
import { WidgetsQuotaService } from '../quota/widgets-quota.service';
import { WidgetsCloudflareTurnstileService } from '../ai/widgets-cloudflare-turnstile.service';
import { WidgetsAccessService } from './widgets-access.service';
import { WidgetsDomainRepository } from './widgets-domain.repository';
import {
	asJsonObject,
	assertExpectedDraftRevision,
	getDraftConfig,
	getDraftInstallDomain,
	getWidgetDefinition,
	hasUnpublishedChanges,
	projectWidgetDraft,
	toInputJson,
	WidgetEntity,
	WidgetType
} from './widgets-domain.types';
import {
	isAllowedAiPrivacyUrl,
	normalizeWidgetConfig
} from './widgets-config-normalizer';
import { WidgetsImageLifecycleService } from './widgets-image-lifecycle.service';
import { WidgetsReportingService } from './widgets-reporting.service';

const TX_OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 5_000,
	timeout: 15_000
} as const;

@Injectable()
export class WidgetsLifecycleService {
	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly access: WidgetsAccessService,
		private readonly quota: WidgetsQuotaService,
		private readonly reporting: WidgetsReportingService,
		private readonly events: WidgetsDomainEventsService,
		private readonly imageLifecycle: WidgetsImageLifecycleService,
		private readonly turnstile: WidgetsCloudflareTurnstileService
	) {}

	async state(type: WidgetType, widgetId: string, userId: string) {
		return this.serializeState(
			type,
			await this.access.owned(type, widgetId, userId)
		);
	}

	async publish(
		type: WidgetType,
		widgetId: string,
		userId: string,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		const publish = () =>
			this.repository.client().$transaction(async transaction => {
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
				this.assertPublishCandidate(type, widget, expectedDraftRevision);
				const version = widget.publishedVersion + 1;
				await transaction.widgetConfigRevision.create({
					data: {
						widgetType: type,
						widgetId,
						version,
						config: toInputJson(getDraftConfig(widget)),
						installDomain: getDraftInstallDomain(widget)
					}
				});
				const count = await this.repository.updateMany(
					type,
					transaction,
					{
						id: widgetId,
						userId,
						draftRevision: expectedDraftRevision,
						publishedVersion: widget.publishedVersion
					},
					{
						config: toInputJson(getDraftConfig(widget)),
						installDomain: getDraftInstallDomain(widget),
						publishedVersion: version,
						publishedFromDraftRevision: expectedDraftRevision,
						publishedAt: new Date()
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
				if (widget.installDomain !== updated.installDomain) {
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
						action: 'WIDGET_PUBLISH',
						actorId: audit.actorId,
						correlationId,
						widget: updated,
						widgetType: type,
						metadata: { version }
					});
				}
			}, TX_OPTIONS);
		if (type === WidgetType.AI_CONSULTANT) {
			const widget = await this.repository
				.client()
				.$transaction(async transaction => {
					await this.access.assertOwnerCanModify(
						transaction,
						userId,
						Boolean(audit)
					);
					return this.access.owned(type, widgetId, userId, transaction);
				}, TX_OPTIONS);
			this.assertPublishCandidate(type, widget, expectedDraftRevision);
			await this.turnstile.withPublishedHostname(
				widget.id,
				getDraftInstallDomain(widget),
				publish
			);
		} else {
			await publish();
		}
		return this.state(type, widgetId, userId);
	}

	private assertPublishCandidate(
		type: WidgetType,
		widget: WidgetEntity,
		expectedDraftRevision: number
	): void {
		assertExpectedDraftRevision(widget, expectedDraftRevision);
		if (!hasUnpublishedChanges(widget)) {
			throw new BadRequestException(
				'В черновике нет изменений для публикации'
			);
		}
		const readiness = this.readiness(type, widget);
		if (!readiness.ready) {
			throw new BadRequestException({
				message: 'Виджет пока не готов к публикации',
				readiness
			});
		}
	}

	async versions(
		type: WidgetType,
		widgetId: string,
		userId: string,
		page: number,
		limit: number
	) {
		await this.access.owned(type, widgetId, userId);
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = { widgetType: type, widgetId };
		const [items, total] = await this.repository.client().$transaction([
			this.repository.client().widgetConfigRevision.findMany({
				where,
				orderBy: { version: 'desc' },
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit,
				select: { version: true, sourceVersion: true, createdAt: true }
			}),
			this.repository.client().widgetConfigRevision.count({ where })
		]);
		return {
			items,
			page: normalizedPage,
			limit: normalizedLimit,
			total,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async restore(
		type: WidgetType,
		widgetId: string,
		version: number,
		userId: string,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		let previousImage: unknown;
		await this.repository.client().$transaction(async transaction => {
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
			previousImage = asJsonObject(getDraftConfig(widget)).buttonImageUrl;
			assertExpectedDraftRevision(widget, expectedDraftRevision);
			const revision = await transaction.widgetConfigRevision.findUnique({
				where: {
					widgetType_widgetId_version: {
						widgetType: type,
						widgetId,
						version
					}
				}
			});
			if (!revision)
				throw new NotFoundException('Версия виджета не найдена');
			const count = await this.repository.updateMany(
				type,
				transaction,
				{
					id: widgetId,
					userId,
					draftRevision: expectedDraftRevision
				},
				{
					draftConfig: revision.config,
					draftInstallDomain: revision.installDomain,
					draftRevision: { increment: 1 }
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
			if (audit) {
				await this.events.enqueueAdminAudit(transaction, {
					action: 'WIDGET_VERSION_RESTORE',
					actorId: audit.actorId,
					correlationId,
					widget: updated,
					widgetType: type,
					metadata: { version }
				});
			}
		}, TX_OPTIONS);
		await this.imageLifecycle.cleanupIfUnreferenced(
			type,
			widgetId,
			previousImage
		);
		return this.state(type, widgetId, userId);
	}

	async discard(
		type: WidgetType,
		widgetId: string,
		userId: string,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		let previousImage: unknown;
		await this.repository.client().$transaction(async transaction => {
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
			previousImage = asJsonObject(getDraftConfig(widget)).buttonImageUrl;
			assertExpectedDraftRevision(widget, expectedDraftRevision);
			const nextRevision = expectedDraftRevision + 1;
			const count = await this.repository.updateMany(
				type,
				transaction,
				{
					id: widgetId,
					userId,
					draftRevision: expectedDraftRevision
				},
				{
					draftConfig: widget.config,
					draftInstallDomain: widget.installDomain,
					draftRevision: nextRevision,
					...(widget.publishedVersion > 0 && {
						publishedFromDraftRevision: nextRevision
					})
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
			if (audit) {
				await this.events.enqueueAdminAudit(transaction, {
					action: 'WIDGET_DRAFT_DISCARD',
					actorId: audit.actorId,
					correlationId,
					widget: updated,
					widgetType: type,
					metadata: {}
				});
			}
		}, TX_OPTIONS);
		await this.imageLifecycle.cleanupIfUnreferenced(
			type,
			widgetId,
			previousImage
		);
		return this.state(type, widgetId, userId);
	}

	async clone(
		type: WidgetType,
		widgetId: string,
		userId: string,
		requestedName: string | undefined,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		const source = await this.access.owned(type, widgetId, userId);
		const sourceConfig = asJsonObject(getDraftConfig(source));
		const hadImage = Boolean(sourceConfig.buttonImageUrl);
		delete sourceConfig.buttonImageUrl;
		const config = normalizeWidgetConfig(type, {
			...sourceConfig,
			buttonImageUrl: ''
		});
		const name = requestedName?.trim() || `${source.name} — копия`;
		const cloned = await this.quota.withWidgetCreation(
			userId,
			{
				idempotencyKey: `widget-clone:${userId}:${widgetId}:${correlationId}`,
				correlationId
			},
			async transaction => {
				const widget = await this.repository.create(type, transaction, {
					userId,
					publicKey: randomBytes(6).toString('hex'),
					name: name.slice(0, 50),
					isActive: false,
					config,
					draftConfig: config,
					draftInstallDomain: getDraftInstallDomain(source),
					draftRevision: 1
				});
				await this.reporting.enqueueWidget(
					transaction,
					type,
					widget,
					false,
					correlationId
				);
				if (audit) {
					await this.events.enqueueAdminAudit(transaction, {
						action: 'WIDGET_CLONE',
						actorId: audit.actorId,
						correlationId,
						widget,
						widgetType: type,
						metadata: { sourceWidgetId: source.id }
					});
				}
				return {
					value: widget,
					aggregateType: this.reporting.widgetAggregateType(type),
					aggregateId: this.reporting.aggregateId(type, widget.id)
				};
			}
		);
		return {
			id: cloned.id,
			type: getWidgetDefinition(type).slug,
			name: cloned.name,
			...(hadImage && {
				warning:
					'Пользовательское изображение кнопки не скопировано. Загрузите его заново'
			})
		};
	}

	async adminGet(type: WidgetType, widgetId: string) {
		return this.serializeState(
			type,
			await this.access.require(type, widgetId)
		);
	}

	async ownerId(type: WidgetType, widgetId: string): Promise<string> {
		return (await this.access.require(type, widgetId)).userId;
	}

	private serializeState(type: WidgetType, widget: WidgetEntity) {
		const projected = projectWidgetDraft(widget);
		return {
			type: getWidgetDefinition(type).slug,
			id: projected.id,
			name: projected.name,
			isActive: projected.isActive,
			publicKey: projected.publicKey,
			installDomain: projected.installDomain,
			config: projected.config,
			createdAt: projected.createdAt,
			updatedAt: projected.updatedAt,
			draftRevision: projected.draftRevision,
			publishedVersion: projected.publishedVersion,
			publishedFromDraftRevision: projected.publishedFromDraftRevision,
			publishedAt: projected.publishedAt,
			status: projected.status,
			hasUnpublishedChanges: projected.hasUnpublishedChanges,
			readiness: this.readiness(type, widget)
		};
	}

	private readiness(type: WidgetType, widget: WidgetEntity) {
		const blockers: Array<{ code: string; message: string }> = [];
		const warnings: Array<{ code: string; message: string }> = [];
		const config = asJsonObject(getDraftConfig(widget));
		const contactType =
			type === WidgetType.AI_CONSULTANT
				? 'NONE'
				: type === WidgetType.CALLBACK
					? 'PHONE'
					: String(config.dataType || '').toUpperCase();
		if (
			!['PHONE', 'EMAIL', 'PHONE_AND_EMAIL', 'NONE'].includes(contactType)
		) {
			blockers.push({
				code: 'CONTACT_METHOD_REQUIRED',
				message: 'Выберите способ связи с клиентом'
			});
		}
		if (
			type === WidgetType.QUIZ &&
			(!Array.isArray(config.questions) || !config.questions.length)
		) {
			blockers.push({
				code: 'QUESTIONS_REQUIRED',
				message: 'Добавьте хотя бы один вопрос'
			});
		}
		if (
			type === WidgetType.CALCULATOR &&
			(!Array.isArray(config.fields) || !config.fields.length)
		) {
			blockers.push({
				code: 'FIELDS_REQUIRED',
				message: 'Добавьте хотя бы одно поле'
			});
		}
		if (
			type === WidgetType.AI_CONSULTANT &&
			!String(config.instructionsPrompt || '').trim()
		) {
			blockers.push({
				code: 'INSTRUCTIONS_PROMPT_REQUIRED',
				message: 'Добавьте инструкции и информацию для AI-консультанта'
			});
		}
		if (type === WidgetType.AI_CONSULTANT) {
			if (!isAllowedAiPrivacyUrl(config.privacyUrl)) {
				blockers.push({
					code: 'PRIVACY_URL_REQUIRED',
					message:
						'Укажите политику владельца сайта с раскрытием обработки Cloudflare AI'
				});
			}
		}
		if (contactType !== 'NONE') {
			try {
				const privacy = new URL(String(config.privacyUrl || ''));
				if (!['http:', 'https:'].includes(privacy.protocol))
					throw new Error();
			} catch {
				blockers.push({
					code: 'CONSENT_REQUIRED',
					message: 'Укажите ссылку на согласие на обработку данных'
				});
			}
		}
		if (!getDraftInstallDomain(widget)) {
			warnings.push({
				code: 'INSTALL_DOMAIN_REQUIRED',
				message:
					type === WidgetType.AI_CONSULTANT ||
					type === WidgetType.STOP_OFFER ||
					type === WidgetType.TIMER
						? 'Домен не указан — виджет не появится на сайте'
						: 'Домен не указан — виджет будет работать только по прямой ссылке'
			});
		}
		if (!widget.publishedVersion) {
			warnings.push({
				code: 'NOT_PUBLISHED',
				message: 'Виджет ещё не опубликован'
			});
		}
		if (!widget.isActive) {
			warnings.push({ code: 'INACTIVE', message: 'Виджет выключен' });
		}
		return { ready: blockers.length === 0, blockers, warnings };
	}
}
