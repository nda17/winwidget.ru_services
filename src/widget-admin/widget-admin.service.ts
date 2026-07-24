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
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { AuthIdentityType, Prisma } from '@prisma/client';
import { maxLength } from 'class-validator';
import { Request } from 'express';
import { isDeepStrictEqual } from 'node:util';

export enum AdminWidgetType {
	WHEEL = 'WHEEL',
	QUIZ = 'QUIZ',
	CALLBACK = 'CALLBACK',
	TIMER = 'TIMER',
	STOP_OFFER = 'STOP_OFFER',
	ONLINE_CONSULTANT = 'ONLINE_CONSULTANT',
	CALCULATOR = 'CALCULATOR'
}

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

interface UserWithIdentities {
	id: string;
	name: string | null;
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
		private readonly adminEventLogService: AdminEventLogService
	) {}

	async getWidget(type: AdminWidgetType, widgetId: string) {
		const { entity, owner } = await this.getEntityAndOwner(type, widgetId);

		return {
			type,
			entity,
			owner
		};
	}

	async updateWidget(
		type: AdminWidgetType,
		widgetId: string,
		dto: UpdateAdminWidgetDto,
		adminId: string,
		request?: Request
	) {
		this.assertNameLength(type, dto.name);

		const { entity: currentEntity, owner } = await this.getEntityAndOwner(
			type,
			widgetId
		);
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

	async uploadButtonImage(
		type: AdminWidgetType,
		widgetId: string,
		file: Express.Multer.File | undefined,
		adminId: string,
		request?: Request
	) {
		if (type === AdminWidgetType.STOP_OFFER) {
			throw new BadRequestException(
				'Загрузка изображения кнопки для стоп-оффера не поддерживается'
			);
		}

		const { owner } = await this.getEntityAndOwner(type, widgetId);
		const updatedEntity = await this.dispatchButtonImageUpload(
			type,
			owner.id,
			widgetId,
			file
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

	private async getEntityAndOwner(
		type: AdminWidgetType,
		widgetId: string
	): Promise<{
		entity: AdminWidgetEntity;
		owner: AdminWidgetOwner;
	}> {
		const record = await this.findWidgetWithOwner(type, widgetId);

		if (!record) {
			throw new NotFoundException(this.getNotFoundMessage(type));
		}

		const { user, ...entity } = record;

		return {
			entity,
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
		type: AdminWidgetType,
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
			case AdminWidgetType.WHEEL:
				return this.prisma.widget.findUnique(args);
			case AdminWidgetType.QUIZ:
				return this.prisma.quiz.findUnique(args);
			case AdminWidgetType.CALLBACK:
				return this.prisma.callback.findUnique(args);
			case AdminWidgetType.TIMER:
				return this.prisma.countdownTimer.findUnique(args);
			case AdminWidgetType.STOP_OFFER:
				return this.prisma.stopOffer.findUnique(args);
			case AdminWidgetType.ONLINE_CONSULTANT:
				return this.prisma.onlineConsultant.findUnique(args);
			case AdminWidgetType.CALCULATOR:
				return this.prisma.calculator.findUnique(args);
		}
	}

	private dispatchUpdate(
		type: AdminWidgetType,
		ownerId: string,
		widgetId: string,
		dto: UpdateAdminWidgetDto
	): Promise<AdminWidgetEntity> {
		switch (type) {
			case AdminWidgetType.WHEEL:
				return this.widgetService.updateWidget(
					ownerId,
					widgetId,
					dto as UpdateWidgetDto
				);
			case AdminWidgetType.QUIZ:
				return this.quizService.updateQuiz(
					ownerId,
					widgetId,
					dto as UpdateQuizDto
				);
			case AdminWidgetType.CALLBACK:
				return this.callbackService.updateCallback(
					ownerId,
					widgetId,
					dto as UpdateCallbackDto
				);
			case AdminWidgetType.TIMER:
				return this.countdownTimerService.updateCountdownTimer(
					ownerId,
					widgetId,
					dto as UpdateCountdownTimerDto
				);
			case AdminWidgetType.STOP_OFFER:
				return this.stopOfferService.updateStopOffer(
					ownerId,
					widgetId,
					dto as UpdateStopOfferDto
				);
			case AdminWidgetType.ONLINE_CONSULTANT:
				return this.onlineConsultantService.updateOnlineConsultant(
					ownerId,
					widgetId,
					dto as UpdateOnlineConsultantDto
				);
			case AdminWidgetType.CALCULATOR:
				return this.calculatorService.updateCalculator(
					ownerId,
					widgetId,
					dto as UpdateCalculatorDto
				);
		}
	}

	private dispatchButtonImageUpload(
		type: Exclude<AdminWidgetType, AdminWidgetType.STOP_OFFER>,
		ownerId: string,
		widgetId: string,
		file: Express.Multer.File | undefined
	): Promise<AdminWidgetEntity> {
		switch (type) {
			case AdminWidgetType.WHEEL:
				return this.widgetService.uploadButtonImage(
					ownerId,
					widgetId,
					file
				);
			case AdminWidgetType.QUIZ:
				return this.quizService.uploadButtonImage(ownerId, widgetId, file);
			case AdminWidgetType.CALLBACK:
				return this.callbackService.uploadButtonImage(
					ownerId,
					widgetId,
					file
				);
			case AdminWidgetType.TIMER:
				return this.countdownTimerService.uploadButtonImage(
					ownerId,
					widgetId,
					file
				);
			case AdminWidgetType.ONLINE_CONSULTANT:
				return this.onlineConsultantService.uploadButtonImage(
					ownerId,
					widgetId,
					file
				);
			case AdminWidgetType.CALCULATOR:
				return this.calculatorService.uploadButtonImage(
					ownerId,
					widgetId,
					file
				);
		}
	}

	private assertNameLength(type: AdminWidgetType, name?: string) {
		const maxNameLength = this.getNameMaxLength(type);

		if (name !== undefined && !maxLength(name, maxNameLength)) {
			throw new BadRequestException(
				`name must be shorter than or equal to ${maxNameLength} characters`
			);
		}
	}

	private getNameMaxLength(type: AdminWidgetType) {
		return [
			AdminWidgetType.WHEEL,
			AdminWidgetType.QUIZ,
			AdminWidgetType.CALLBACK
		].includes(type)
			? 15
			: 50;
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

	private getNotFoundMessage(type: AdminWidgetType) {
		switch (type) {
			case AdminWidgetType.WHEEL:
				return 'Колесо фортуны не найдено';
			case AdminWidgetType.QUIZ:
				return 'Квиз не найден';
			case AdminWidgetType.CALLBACK:
				return 'Виджет обратного звонка не найден';
			case AdminWidgetType.TIMER:
				return 'Таймер не найден';
			case AdminWidgetType.STOP_OFFER:
				return 'Стоп-оффер не найден';
			case AdminWidgetType.ONLINE_CONSULTANT:
				return 'Онлайн-консультант не найден';
			case AdminWidgetType.CALCULATOR:
				return 'Калькулятор не найден';
		}
	}
}
