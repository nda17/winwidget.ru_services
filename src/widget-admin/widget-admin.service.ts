import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { CalculatorService } from '@/calculator/calculator.service';
import { UpdateCalculatorDto } from '@/calculator/dto/update-calculator.dto';
import { CallbackService } from '@/callback/callback.service';
import { UpdateCallbackDto } from '@/callback/dto/update-callback.dto';
import { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
import { UpdateCountdownTimerDto } from '@/countdown-timer/dto/update-countdown-timer.dto';
import { UpdateOnlineConsultantDto } from '@/online-consultant/dto/update-online-consultant.dto';
import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import { PrismaService } from '@/prisma.service';
import { UpdateQuizDto } from '@/quiz/dto/update-quiz.dto';
import { QuizService } from '@/quiz/quiz.service';
import { UpdateStopOfferDto } from '@/stop-offer/dto/update-stop-offer.dto';
import { StopOfferService } from '@/stop-offer/stop-offer.service';
import { UpdateAdminWidgetDto } from '@/widget-admin/dto/update-admin-widget.dto';
import { UpdateWidgetDto } from '@/widget/dto/update-widget.dto';
import { WidgetService } from '@/widget/widget.service';
import {
	projectWidgetDraft,
	WidgetLifecycleEntity,
	WidgetType
} from '@/widget-domain/widget-lifecycle';
import { WidgetSettingsService } from '@/widget-settings/widget-settings.service';
import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { AuthIdentityType, Prisma, UserStatus } from '@prisma/client';
import { maxLength } from 'class-validator';
import { Request } from 'express';
import { isDeepStrictEqual } from 'node:util';

const WIDGET_NAME_MAX_LENGTH = 50;

export interface AdminWidgetOwner {
	id: string;
	name: string | null;
	email: string | null;
	phone: string | null;
}

export interface AdminWidgetEntity {
	id: string;
	userId: string;
	name: string;
	isActive: boolean;
	installDomain: string;
	config: unknown;
	[key: string]: unknown;
}

export interface AdminWidgetDeleteResponse {
	type: WidgetType;
	id: string;
}

interface UserWithIdentities {
	id: string;
	name: string | null;
	status: UserStatus;
	deletedAt: Date | null;
	authIdentities: Array<{
		type: AuthIdentityType;
		value: string;
	}>;
}

interface AdminWidgetEntityWithUser extends AdminWidgetEntity {
	user: UserWithIdentities;
}

@Injectable()
export class WidgetAdminService {
	private readonly ownerSelect: Prisma.UserSelect = {
		id: true,
		name: true,
		status: true,
		deletedAt: true,
		authIdentities: {
			where: {
				type: {
					in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
				}
			},
			select: {
				type: true,
				value: true
			}
		}
	};

	constructor(
		private readonly prisma: PrismaService,
		private readonly widgetService: WidgetService,
		private readonly quizService: QuizService,
		private readonly callbackService: CallbackService,
		private readonly countdownTimerService: CountdownTimerService,
		private readonly stopOfferService: StopOfferService,
		private readonly onlineConsultantService: OnlineConsultantService,
		private readonly calculatorService: CalculatorService,
		private readonly widgetSettingsService: WidgetSettingsService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	async getWidget(type: WidgetType, widgetId: string) {
		const { entity, owner } = await this.getEntityAndOwner(type, widgetId);

		return {
			type,
			entity,
			owner
		};
	}

	async updateWidget(
		type: WidgetType,
		widgetId: string,
		dto: UpdateAdminWidgetDto,
		adminId: string,
		request?: Request
	) {
		this.assertNameLength(dto.name);

		const {
			entity: currentEntity,
			owner,
			ownerStatus
		} = await this.getEntityAndOwner(type, widgetId);

		if (dto.isActive === true && ownerStatus !== UserStatus.ACTIVE) {
			throw new BadRequestException(
				'Сначала активируйте владельца виджета'
			);
		}

		const updatedEntity = await this.dispatchUpdate(
			type,
			owner.id,
			widgetId,
			dto
		);
		const changedFields = this.getChangedFields(
			currentEntity,
			updatedEntity,
			dto
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'WIDGETS',
			action: 'WIDGET_UPDATE',
			description: `Обновлён пользовательский виджет «${updatedEntity.name}»`,
			entityType: 'widget',
			entityId: widgetId,
			entityLabel: updatedEntity.name,
			targetUserId: owner.id,
			metadata: {
				type,
				id: widgetId,
				ownerId: owner.id,
				changedFields
			},
			request
		});

		return {
			type,
			entity: updatedEntity
		};
	}

	async publishWidget(
		type: WidgetType,
		widgetId: string,
		expectedDraftRevision: number,
		adminId: string,
		request?: Request
	) {
		const { entity, owner } = await this.getEntityAndOwner(type, widgetId);
		const published = await this.widgetSettingsService.publish(
			type,
			widgetId,
			owner.id,
			expectedDraftRevision
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'WIDGETS',
			action: 'WIDGET_PUBLISH',
			description: `Опубликован пользовательский виджет «${entity.name}»`,
			entityType: 'widget',
			entityId: widgetId,
			entityLabel: entity.name,
			targetUserId: owner.id,
			metadata: {
				type,
				id: widgetId,
				ownerId: owner.id,
				publishedVersion: published.publishedVersion
			},
			request
		});

		return published;
	}

	async discardDraft(
		type: WidgetType,
		widgetId: string,
		expectedDraftRevision: number,
		adminId: string,
		request?: Request
	) {
		const { entity, owner } = await this.getEntityAndOwner(type, widgetId);
		const discarded = await this.widgetSettingsService.discardDraft(
			type,
			widgetId,
			owner.id,
			expectedDraftRevision
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'WIDGETS',
			action: 'WIDGET_DRAFT_DISCARD',
			description: `Отменены черновые изменения пользовательского виджета «${entity.name}»`,
			entityType: 'widget',
			entityId: widgetId,
			entityLabel: entity.name,
			targetUserId: owner.id,
			metadata: {
				type,
				id: widgetId,
				ownerId: owner.id,
				draftRevision: discarded.draftRevision
			},
			request
		});

		return discarded;
	}

	async uploadButtonImage(
		type: WidgetType,
		widgetId: string,
		file: Express.Multer.File | undefined,
		expectedDraftRevision: number,
		adminId: string,
		request?: Request
	) {
		if (type === WidgetType.STOP_OFFER) {
			throw new BadRequestException(
				'Загрузка изображения кнопки для стоп-оффера не поддерживается'
			);
		}

		const { owner } = await this.getEntityAndOwner(type, widgetId);
		const updatedEntity = await this.dispatchButtonImageUpload(
			type,
			owner.id,
			widgetId,
			file,
			expectedDraftRevision
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'WIDGETS',
			action: 'WIDGET_BUTTON_IMAGE_UPDATE',
			description: `Обновлено изображение кнопки пользовательского виджета «${updatedEntity.name}»`,
			entityType: 'widget',
			entityId: widgetId,
			entityLabel: updatedEntity.name,
			targetUserId: owner.id,
			metadata: {
				type,
				id: widgetId,
				ownerId: owner.id,
				changedFields: ['config.buttonImageUrl']
			},
			request
		});

		return {
			type,
			entity: updatedEntity
		};
	}

	async deleteWidget(
		type: WidgetType,
		widgetId: string,
		adminId: string,
		request?: Request
	): Promise<AdminWidgetDeleteResponse> {
		const { entity, owner } = await this.getEntityAndOwner(type, widgetId);

		await this.dispatchDelete(type, owner.id, widgetId);

		await this.adminEventLogService.record({
			adminId,
			section: 'WIDGETS',
			action: 'WIDGET_DELETE',
			description: `Удалён пользовательский виджет «${entity.name}»`,
			entityType: 'widget',
			entityId: widgetId,
			entityLabel: entity.name,
			targetUserId: owner.id,
			metadata: {
				type,
				id: widgetId,
				ownerId: owner.id
			},
			request
		});

		return {
			type,
			id: widgetId
		};
	}

	private async getEntityAndOwner(
		type: WidgetType,
		widgetId: string
	): Promise<{
		entity: AdminWidgetEntity;
		owner: AdminWidgetOwner;
		ownerStatus: UserStatus;
	}> {
		const record = await this.findWidgetWithOwner(type, widgetId);

		if (!record) {
			throw new NotFoundException(this.getNotFoundMessage(type));
		}

		const { user, ...entity } = record;

		if (user.deletedAt) {
			throw new BadRequestException(
				'Сначала восстановите удалённого владельца виджета'
			);
		}

		return {
			entity: projectWidgetDraft(
				entity as unknown as WidgetLifecycleEntity
			) as unknown as AdminWidgetEntity,
			ownerStatus: user.status,
			owner: {
				id: user.id,
				name: user.name,
				email:
					user.authIdentities.find(
						identity => identity.type === AuthIdentityType.EMAIL
					)?.value ?? null,
				phone:
					user.authIdentities.find(
						identity => identity.type === AuthIdentityType.PHONE
					)?.value ?? null
			}
		};
	}

	private async findWidgetWithOwner(
		type: WidgetType,
		widgetId: string
	): Promise<AdminWidgetEntityWithUser | null> {
		const args = {
			where: { id: widgetId },
			include: {
				user: {
					select: this.ownerSelect
				}
			}
		};

		switch (type) {
			case WidgetType.WHEEL:
				return this.prisma.widget.findUnique(args);
			case WidgetType.QUIZ:
				return this.prisma.quiz.findUnique(args);
			case WidgetType.CALLBACK:
				return this.prisma.callback.findUnique(args);
			case WidgetType.TIMER:
				return this.prisma.countdownTimer.findUnique(args);
			case WidgetType.STOP_OFFER:
				return this.prisma.stopOffer.findUnique(args);
			case WidgetType.ONLINE_CONSULTANT:
				return this.prisma.onlineConsultant.findUnique(args);
			case WidgetType.CALCULATOR:
				return this.prisma.calculator.findUnique(args);
		}
	}

	private dispatchUpdate(
		type: WidgetType,
		ownerId: string,
		widgetId: string,
		dto: UpdateAdminWidgetDto
	): Promise<AdminWidgetEntity> {
		switch (type) {
			case WidgetType.WHEEL:
				return this.widgetService.updateWidget(
					ownerId,
					widgetId,
					dto as UpdateWidgetDto
				);
			case WidgetType.QUIZ:
				return this.quizService.updateQuiz(
					ownerId,
					widgetId,
					dto as UpdateQuizDto
				);
			case WidgetType.CALLBACK:
				return this.callbackService.updateCallback(
					ownerId,
					widgetId,
					dto as UpdateCallbackDto
				);
			case WidgetType.TIMER:
				return this.countdownTimerService.updateCountdownTimer(
					ownerId,
					widgetId,
					dto as UpdateCountdownTimerDto
				);
			case WidgetType.STOP_OFFER:
				return this.stopOfferService.updateStopOffer(
					ownerId,
					widgetId,
					dto as UpdateStopOfferDto
				);
			case WidgetType.ONLINE_CONSULTANT:
				return this.onlineConsultantService.updateOnlineConsultant(
					ownerId,
					widgetId,
					dto as UpdateOnlineConsultantDto
				);
			case WidgetType.CALCULATOR:
				return this.calculatorService.updateCalculator(
					ownerId,
					widgetId,
					dto as UpdateCalculatorDto
				);
		}
	}

	private async dispatchDelete(
		type: WidgetType,
		ownerId: string,
		widgetId: string
	): Promise<void> {
		switch (type) {
			case WidgetType.WHEEL:
				await this.widgetService.deleteWidget(ownerId, widgetId);
				return;
			case WidgetType.QUIZ:
				await this.quizService.deleteQuiz(ownerId, widgetId);
				return;
			case WidgetType.CALLBACK:
				await this.callbackService.deleteCallback(ownerId, widgetId);
				return;
			case WidgetType.TIMER:
				await this.countdownTimerService.deleteCountdownTimer(
					ownerId,
					widgetId
				);
				return;
			case WidgetType.STOP_OFFER:
				await this.stopOfferService.deleteStopOffer(ownerId, widgetId);
				return;
			case WidgetType.ONLINE_CONSULTANT:
				await this.onlineConsultantService.deleteOnlineConsultant(
					ownerId,
					widgetId
				);
				return;
			case WidgetType.CALCULATOR:
				await this.calculatorService.deleteCalculator(ownerId, widgetId);
				return;
		}
	}

	private dispatchButtonImageUpload(
		type: Exclude<WidgetType, WidgetType.STOP_OFFER>,
		ownerId: string,
		widgetId: string,
		file: Express.Multer.File | undefined,
		expectedDraftRevision: number
	): Promise<AdminWidgetEntity> {
		switch (type) {
			case WidgetType.WHEEL:
				return this.widgetService.uploadButtonImage(
					ownerId,
					widgetId,
					file,
					expectedDraftRevision
				);
			case WidgetType.QUIZ:
				return this.quizService.uploadButtonImage(
					ownerId,
					widgetId,
					file,
					expectedDraftRevision
				);
			case WidgetType.CALLBACK:
				return this.callbackService.uploadButtonImage(
					ownerId,
					widgetId,
					file,
					expectedDraftRevision
				);
			case WidgetType.TIMER:
				return this.countdownTimerService.uploadButtonImage(
					ownerId,
					widgetId,
					file,
					expectedDraftRevision
				);
			case WidgetType.ONLINE_CONSULTANT:
				return this.onlineConsultantService.uploadButtonImage(
					ownerId,
					widgetId,
					file,
					expectedDraftRevision
				);
			case WidgetType.CALCULATOR:
				return this.calculatorService.uploadButtonImage(
					ownerId,
					widgetId,
					file,
					expectedDraftRevision
				);
		}
	}

	private assertNameLength(name?: string) {
		if (name !== undefined && !maxLength(name, WIDGET_NAME_MAX_LENGTH)) {
			throw new BadRequestException(
				`name must be shorter than or equal to ${WIDGET_NAME_MAX_LENGTH} characters`
			);
		}
	}

	private getChangedFields(
		currentEntity: AdminWidgetEntity,
		updatedEntity: AdminWidgetEntity,
		dto: UpdateAdminWidgetDto
	) {
		return (
			['name', 'isActive', 'installDomain', 'config'] as const
		).filter(
			field =>
				dto[field] !== undefined &&
				!this.areEqual(currentEntity[field], updatedEntity[field])
		);
	}

	private areEqual(first: unknown, second: unknown) {
		return isDeepStrictEqual(first, second);
	}

	private getNotFoundMessage(type: WidgetType) {
		switch (type) {
			case WidgetType.WHEEL:
				return 'Колесо фортуны не найдено';
			case WidgetType.QUIZ:
				return 'Квиз не найден';
			case WidgetType.CALLBACK:
				return 'Виджет обратного звонка не найден';
			case WidgetType.TIMER:
				return 'Таймер не найден';
			case WidgetType.STOP_OFFER:
				return 'Стоп-оффер не найден';
			case WidgetType.ONLINE_CONSULTANT:
				return 'Онлайн-консультант не найден';
			case WidgetType.CALCULATOR:
				return 'Калькулятор не найден';
		}
	}
}
