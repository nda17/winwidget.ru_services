import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { CalculatorService } from '@/calculator/calculator.service';
import type { CallbackService } from '@/callback/callback.service';
import type { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
import type { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import type { PrismaService } from '@/prisma.service';
import type { QuizService } from '@/quiz/quiz.service';
import type { StopOfferService } from '@/stop-offer/stop-offer.service';
import { UpdateAdminWidgetDto } from '@/widget-admin/dto/update-admin-widget.dto';
import { WidgetAdminController } from '@/widget-admin/widget-admin.controller';
import {
	AdminWidgetType,
	WidgetAdminService
} from '@/widget-admin/widget-admin.service';
import type { WidgetService } from '@/widget/widget.service';
import { BadRequestException } from '@nestjs/common';
import { AuthIdentityType, Role } from '@prisma/client';
import type { Request } from 'express';
import { validate } from 'class-validator';

describe('WidgetAdminService', () => {
	const widgetId = 'widget-id';
	const ownerId = 'owner-id';
	const adminId = 'admin-id';
	const request = {} as Request;

	const createFixture = () => {
		const prisma = {
			widget: { findUnique: jest.fn() },
			quiz: { findUnique: jest.fn() },
			callback: { findUnique: jest.fn() },
			countdownTimer: { findUnique: jest.fn() },
			stopOffer: { findUnique: jest.fn() },
			onlineConsultant: { findUnique: jest.fn() },
			calculator: { findUnique: jest.fn() }
		};
		const widgetService = {
			updateWidget: jest.fn(),
			deleteWidget: jest.fn(),
			uploadButtonImage: jest.fn()
		};
		const quizService = {
			updateQuiz: jest.fn(),
			deleteQuiz: jest.fn(),
			uploadButtonImage: jest.fn()
		};
		const callbackService = {
			updateCallback: jest.fn(),
			deleteCallback: jest.fn(),
			uploadButtonImage: jest.fn()
		};
		const countdownTimerService = {
			updateCountdownTimer: jest.fn(),
			deleteCountdownTimer: jest.fn(),
			uploadButtonImage: jest.fn()
		};
		const stopOfferService = {
			updateStopOffer: jest.fn(),
			deleteStopOffer: jest.fn()
		};
		const onlineConsultantService = {
			updateOnlineConsultant: jest.fn(),
			deleteOnlineConsultant: jest.fn(),
			uploadButtonImage: jest.fn()
		};
		const calculatorService = {
			updateCalculator: jest.fn(),
			deleteCalculator: jest.fn(),
			uploadButtonImage: jest.fn()
		};
		const adminEventLogService = {
			record: jest.fn().mockResolvedValue(undefined)
		};
		const service = new WidgetAdminService(
			prisma as unknown as PrismaService,
			widgetService as unknown as WidgetService,
			quizService as unknown as QuizService,
			callbackService as unknown as CallbackService,
			countdownTimerService as unknown as CountdownTimerService,
			stopOfferService as unknown as StopOfferService,
			onlineConsultantService as unknown as OnlineConsultantService,
			calculatorService as unknown as CalculatorService,
			adminEventLogService as unknown as AdminEventLogService
		);

		return {
			service,
			prisma,
			widgetService,
			quizService,
			callbackService,
			countdownTimerService,
			stopOfferService,
			onlineConsultantService,
			calculatorService,
			adminEventLogService
		};
	};

	const createRecord = () => ({
		id: widgetId,
		userId: ownerId,
		publicKey: 'public-key',
		name: 'Старое имя',
		isActive: true,
		installDomain: 'example.com',
		config: {
			title: 'Старый заголовок',
			integrations: {
				webhookUrl: 'https://secret.example/webhook',
				amoCrmToken: 'secret-token'
			}
		},
		createdAt: new Date('2026-07-25T00:00:00.000Z'),
		updatedAt: new Date('2026-07-25T00:00:00.000Z'),
		user: {
			id: ownerId,
			name: 'Владелец',
			authIdentities: [
				{
					type: AuthIdentityType.EMAIL,
					value: 'owner@example.com'
				},
				{
					type: AuthIdentityType.PHONE,
					value: '+79990000000'
				}
			]
		}
	});

	const updateCases = [
		{
			type: AdminWidgetType.WHEEL,
			delegate: 'widget',
			service: 'widgetService',
			method: 'updateWidget'
		},
		{
			type: AdminWidgetType.QUIZ,
			delegate: 'quiz',
			service: 'quizService',
			method: 'updateQuiz'
		},
		{
			type: AdminWidgetType.CALLBACK,
			delegate: 'callback',
			service: 'callbackService',
			method: 'updateCallback'
		},
		{
			type: AdminWidgetType.TIMER,
			delegate: 'countdownTimer',
			service: 'countdownTimerService',
			method: 'updateCountdownTimer'
		},
		{
			type: AdminWidgetType.STOP_OFFER,
			delegate: 'stopOffer',
			service: 'stopOfferService',
			method: 'updateStopOffer'
		},
		{
			type: AdminWidgetType.ONLINE_CONSULTANT,
			delegate: 'onlineConsultant',
			service: 'onlineConsultantService',
			method: 'updateOnlineConsultant'
		},
		{
			type: AdminWidgetType.CALCULATOR,
			delegate: 'calculator',
			service: 'calculatorService',
			method: 'updateCalculator'
		}
	] as const;

	const deleteCases = [
		{
			type: AdminWidgetType.WHEEL,
			delegate: 'widget',
			service: 'widgetService',
			method: 'deleteWidget'
		},
		{
			type: AdminWidgetType.QUIZ,
			delegate: 'quiz',
			service: 'quizService',
			method: 'deleteQuiz'
		},
		{
			type: AdminWidgetType.CALLBACK,
			delegate: 'callback',
			service: 'callbackService',
			method: 'deleteCallback'
		},
		{
			type: AdminWidgetType.TIMER,
			delegate: 'countdownTimer',
			service: 'countdownTimerService',
			method: 'deleteCountdownTimer'
		},
		{
			type: AdminWidgetType.STOP_OFFER,
			delegate: 'stopOffer',
			service: 'stopOfferService',
			method: 'deleteStopOffer'
		},
		{
			type: AdminWidgetType.ONLINE_CONSULTANT,
			delegate: 'onlineConsultant',
			service: 'onlineConsultantService',
			method: 'deleteOnlineConsultant'
		},
		{
			type: AdminWidgetType.CALCULATOR,
			delegate: 'calculator',
			service: 'calculatorService',
			method: 'deleteCalculator'
		}
	] as const;

	it.each(updateCases)(
		'dispatches $type updates through the existing feature service',
		async testCase => {
			const fixture = createFixture();
			const record = createRecord();
			const updated = {
				...record,
				name: 'Новое имя'
			};
			delete (updated as Partial<typeof updated>).user;
			fixture.prisma[testCase.delegate].findUnique.mockResolvedValue(
				record
			);
			fixture[testCase.service][testCase.method].mockResolvedValue(
				updated
			);

			const result = await fixture.service.updateWidget(
				testCase.type,
				widgetId,
				{ name: 'Новое имя' },
				adminId,
				request
			);

			expect(
				fixture[testCase.service][testCase.method]
			).toHaveBeenCalledWith(ownerId, widgetId, {
				name: 'Новое имя'
			});
			expect(result).toEqual({
				type: testCase.type,
				entity: updated
			});
			expect(fixture.adminEventLogService.record).toHaveBeenCalledWith(
				expect.objectContaining({
					adminId,
					section: 'WIDGETS',
					action: 'WIDGET_UPDATE',
					entityId: widgetId,
					targetUserId: ownerId,
					metadata: {
						type: testCase.type,
						id: widgetId,
						ownerId,
						changedFields: ['name']
					},
					request
				})
			);

			const logPayload =
				fixture.adminEventLogService.record.mock.calls[0][0];
			expect(JSON.stringify(logPayload)).not.toContain('secret-token');
			expect(JSON.stringify(logPayload)).not.toContain(
				'https://secret.example/webhook'
			);
		}
	);

	it.each(deleteCases)(
		'dispatches $type deletion through the existing feature service and audits success',
		async testCase => {
			const fixture = createFixture();
			const record = createRecord();
			fixture.prisma[testCase.delegate].findUnique.mockResolvedValue(
				record
			);
			fixture[testCase.service][testCase.method].mockResolvedValue(record);

			const result = await fixture.service.deleteWidget(
				testCase.type,
				widgetId,
				adminId,
				request
			);

			expect(
				fixture[testCase.service][testCase.method]
			).toHaveBeenCalledWith(ownerId, widgetId);
			expect(result).toEqual({
				type: testCase.type,
				id: widgetId
			});
			expect(fixture.adminEventLogService.record).toHaveBeenCalledWith({
				adminId,
				section: 'WIDGETS',
				action: 'WIDGET_DELETE',
				description: 'Удалён пользовательский виджет «Старое имя»',
				entityType: 'widget',
				entityId: widgetId,
				entityLabel: 'Старое имя',
				targetUserId: ownerId,
				metadata: {
					type: testCase.type,
					id: widgetId,
					ownerId
				},
				request
			});

			const logPayload =
				fixture.adminEventLogService.record.mock.calls[0][0];
			expect(JSON.stringify(logPayload)).not.toContain('secret-token');
			expect(JSON.stringify(logPayload)).not.toContain(
				'https://secret.example/webhook'
			);
		}
	);

	it('returns a full entity with only minimal owner fields', async () => {
		const fixture = createFixture();
		fixture.prisma.calculator.findUnique.mockResolvedValue(createRecord());

		await expect(
			fixture.service.getWidget(AdminWidgetType.CALCULATOR, widgetId)
		).resolves.toEqual({
			type: AdminWidgetType.CALCULATOR,
			entity: expect.objectContaining({
				id: widgetId,
				userId: ownerId,
				config: expect.any(Object)
			}),
			owner: {
				id: ownerId,
				name: 'Владелец',
				email: 'owner@example.com',
				phone: '+79990000000'
			}
		});
	});

	it('uses the common 50-character name limit for wheel, quiz and callback', async () => {
		const fixture = createFixture();
		const record = createRecord();
		fixture.prisma.widget.findUnique.mockResolvedValue(record);
		fixture.widgetService.updateWidget.mockResolvedValue(record);

		await expect(
			fixture.service.updateWidget(
				AdminWidgetType.WHEEL,
				widgetId,
				{ name: 'x'.repeat(50) },
				adminId
			)
		).resolves.toEqual(
			expect.objectContaining({ type: AdminWidgetType.WHEEL })
		);

		await expect(
			fixture.service.updateWidget(
				AdminWidgetType.WHEEL,
				widgetId,
				{ name: 'x'.repeat(51) },
				adminId
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('rejects names longer than 50 characters for the other widget types', async () => {
		const fixture = createFixture();
		const dto = Object.assign(new UpdateAdminWidgetDto(), {
			name: 'x'.repeat(51)
		});

		const errors = await validate(dto);

		expect(errors).toHaveLength(1);
		expect(errors[0].constraints?.maxLength).toBeDefined();
		await expect(
			fixture.service.updateWidget(
				AdminWidgetType.CALCULATOR,
				widgetId,
				dto,
				adminId
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(fixture.prisma.calculator.findUnique).not.toHaveBeenCalled();
	});

	it('rejects button-image upload for stop-offer with a clear error', async () => {
		const fixture = createFixture();

		await expect(
			fixture.service.uploadButtonImage(
				AdminWidgetType.STOP_OFFER,
				widgetId,
				undefined,
				adminId
			)
		).rejects.toThrow(
			'Загрузка изображения кнопки для стоп-оффера не поддерживается'
		);
		expect(fixture.prisma.stopOffer.findUnique).not.toHaveBeenCalled();
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();
	});

	it('records button-image changes only after a successful upload', async () => {
		const fixture = createFixture();
		const record = createRecord();
		const updated = {
			...record,
			config: {
				...record.config,
				buttonImageUrl: '/uploads/widget-buttons/wheel/image.png'
			}
		};
		delete (updated as Partial<typeof updated>).user;
		fixture.prisma.widget.findUnique.mockResolvedValue(record);
		fixture.widgetService.uploadButtonImage.mockResolvedValue(updated);
		const file = { originalname: 'image.png' } as Express.Multer.File;

		await fixture.service.uploadButtonImage(
			AdminWidgetType.WHEEL,
			widgetId,
			file,
			adminId,
			request
		);

		expect(fixture.widgetService.uploadButtonImage).toHaveBeenCalledWith(
			ownerId,
			widgetId,
			file
		);
		expect(fixture.adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'WIDGET_BUTTON_IMAGE_UPDATE',
				metadata: {
					type: AdminWidgetType.WHEEL,
					id: widgetId,
					ownerId,
					changedFields: ['config.buttonImageUrl']
				}
			})
		);
	});

	it('does not write an audit event when the delegated update fails', async () => {
		const fixture = createFixture();
		fixture.prisma.quiz.findUnique.mockResolvedValue(createRecord());
		fixture.quizService.updateQuiz.mockRejectedValue(
			new BadRequestException('Ошибка интеграции')
		);

		await expect(
			fixture.service.updateWidget(
				AdminWidgetType.QUIZ,
				widgetId,
				{ config: { title: 'Новое значение' } },
				adminId
			)
		).rejects.toThrow('Ошибка интеграции');
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();
	});

	it('does not write an audit event when the delegated deletion fails', async () => {
		const fixture = createFixture();
		fixture.prisma.quiz.findUnique.mockResolvedValue(createRecord());
		fixture.quizService.deleteQuiz.mockRejectedValue(
			new BadRequestException('Удаление не выполнено')
		);

		await expect(
			fixture.service.deleteWidget(AdminWidgetType.QUIZ, widgetId, adminId)
		).rejects.toThrow('Удаление не выполнено');
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();
	});
});

describe('WidgetAdminController authorization', () => {
	it('allows ADMIN and DEV to use the administrative editor', () => {
		expect(Reflect.getMetadata('roles', WidgetAdminController)).toEqual([
			Role.ADMIN,
			Role.DEV
		]);
	});

	it('allows ADMIN and DEV to delete a user widget', () => {
		expect(
			Reflect.getMetadata(
				'roles',
				WidgetAdminController.prototype.deleteWidget
			)
		).toEqual([Role.ADMIN, Role.DEV]);
	});
});
