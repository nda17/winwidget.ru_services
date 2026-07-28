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
import { WidgetAdminService } from '@/widget-admin/widget-admin.service';
import type { WidgetService } from '@/widget/widget.service';
import { WidgetType } from '@/widget-domain/widget-lifecycle';
import type { WidgetSettingsService } from '@/widget-settings/widget-settings.service';
import { BadRequestException } from '@nestjs/common';
import { AuthIdentityType, Role, UserStatus } from '@prisma/client';
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
		const widgetSettingsService = {
			publish: jest.fn(),
			discardDraft: jest.fn()
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
			widgetSettingsService as unknown as WidgetSettingsService,
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
			widgetSettingsService,
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
			status: UserStatus.ACTIVE as UserStatus,
			deletedAt: null as Date | null,
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
			type: WidgetType.WHEEL,
			delegate: 'widget',
			service: 'widgetService',
			method: 'updateWidget'
		},
		{
			type: WidgetType.QUIZ,
			delegate: 'quiz',
			service: 'quizService',
			method: 'updateQuiz'
		},
		{
			type: WidgetType.CALLBACK,
			delegate: 'callback',
			service: 'callbackService',
			method: 'updateCallback'
		},
		{
			type: WidgetType.TIMER,
			delegate: 'countdownTimer',
			service: 'countdownTimerService',
			method: 'updateCountdownTimer'
		},
		{
			type: WidgetType.STOP_OFFER,
			delegate: 'stopOffer',
			service: 'stopOfferService',
			method: 'updateStopOffer'
		},
		{
			type: WidgetType.ONLINE_CONSULTANT,
			delegate: 'onlineConsultant',
			service: 'onlineConsultantService',
			method: 'updateOnlineConsultant'
		},
		{
			type: WidgetType.CALCULATOR,
			delegate: 'calculator',
			service: 'calculatorService',
			method: 'updateCalculator'
		}
	] as const;

	const deleteCases = [
		{
			type: WidgetType.WHEEL,
			delegate: 'widget',
			service: 'widgetService',
			method: 'deleteWidget'
		},
		{
			type: WidgetType.QUIZ,
			delegate: 'quiz',
			service: 'quizService',
			method: 'deleteQuiz'
		},
		{
			type: WidgetType.CALLBACK,
			delegate: 'callback',
			service: 'callbackService',
			method: 'deleteCallback'
		},
		{
			type: WidgetType.TIMER,
			delegate: 'countdownTimer',
			service: 'countdownTimerService',
			method: 'deleteCountdownTimer'
		},
		{
			type: WidgetType.STOP_OFFER,
			delegate: 'stopOffer',
			service: 'stopOfferService',
			method: 'deleteStopOffer'
		},
		{
			type: WidgetType.ONLINE_CONSULTANT,
			delegate: 'onlineConsultant',
			service: 'onlineConsultantService',
			method: 'deleteOnlineConsultant'
		},
		{
			type: WidgetType.CALCULATOR,
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
			fixture.service.getWidget(WidgetType.CALCULATOR, widgetId)
		).resolves.toEqual({
			type: WidgetType.CALCULATOR,
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

	it('does not expose or mutate widgets of a deleted owner', async () => {
		const fixture = createFixture();
		const record = createRecord();
		record.user.deletedAt = new Date('2026-07-28T08:00:00.000Z');
		fixture.prisma.widget.findUnique.mockResolvedValue(record);

		await expect(
			fixture.service.getWidget(WidgetType.WHEEL, widgetId)
		).rejects.toThrow('Сначала восстановите удалённого владельца виджета');
		await expect(
			fixture.service.updateWidget(
				WidgetType.WHEEL,
				widgetId,
				{ isActive: true },
				adminId
			)
		).rejects.toThrow('Сначала восстановите удалённого владельца виджета');
		await expect(
			fixture.service.deleteWidget(WidgetType.WHEEL, widgetId, adminId)
		).rejects.toThrow('Сначала восстановите удалённого владельца виджета');

		expect(fixture.widgetService.updateWidget).not.toHaveBeenCalled();
		expect(fixture.widgetService.deleteWidget).not.toHaveBeenCalled();
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();
	});

	it('does not activate a widget while its owner is deactivated', async () => {
		const fixture = createFixture();
		const record = createRecord();
		record.user.status = UserStatus.DEACTIVATED;
		fixture.prisma.widget.findUnique.mockResolvedValue(record);

		await expect(
			fixture.service.updateWidget(
				WidgetType.WHEEL,
				widgetId,
				{ isActive: true },
				adminId
			)
		).rejects.toThrow('Сначала активируйте владельца виджета');

		expect(fixture.widgetService.updateWidget).not.toHaveBeenCalled();
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();
	});

	it('uses the common 50-character name limit for wheel, quiz and callback', async () => {
		const fixture = createFixture();
		const record = createRecord();
		fixture.prisma.widget.findUnique.mockResolvedValue(record);
		fixture.widgetService.updateWidget.mockResolvedValue(record);

		await expect(
			fixture.service.updateWidget(
				WidgetType.WHEEL,
				widgetId,
				{ name: 'x'.repeat(50) },
				adminId
			)
		).resolves.toEqual(
			expect.objectContaining({ type: WidgetType.WHEEL })
		);

		await expect(
			fixture.service.updateWidget(
				WidgetType.WHEEL,
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
				WidgetType.CALCULATOR,
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
				WidgetType.STOP_OFFER,
				widgetId,
				undefined,
				2,
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
			WidgetType.WHEEL,
			widgetId,
			file,
			2,
			adminId,
			request
		);

		expect(fixture.widgetService.uploadButtonImage).toHaveBeenCalledWith(
			ownerId,
			widgetId,
			file,
			2
		);
		expect(fixture.adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'WIDGET_BUTTON_IMAGE_UPDATE',
				metadata: {
					type: WidgetType.WHEEL,
					id: widgetId,
					ownerId,
					changedFields: ['config.buttonImageUrl']
				}
			})
		);
	});

	it('publishes a user widget through the shared lifecycle and records it', async () => {
		const fixture = createFixture();
		const record = createRecord();
		const published = {
			type: 'wheel',
			id: widgetId,
			name: record.name,
			publishedVersion: 2,
			draftRevision: 3
		};
		fixture.prisma.widget.findUnique.mockResolvedValue(record);
		fixture.widgetSettingsService.publish.mockResolvedValue(published);

		await expect(
			fixture.service.publishWidget(
				WidgetType.WHEEL,
				widgetId,
				3,
				adminId,
				request
			)
		).resolves.toBe(published);
		expect(fixture.widgetSettingsService.publish).toHaveBeenCalledWith(
			WidgetType.WHEEL,
			widgetId,
			ownerId,
			3
		);
		expect(fixture.adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'WIDGET_PUBLISH',
				metadata: expect.objectContaining({
					type: WidgetType.WHEEL,
					publishedVersion: 2
				})
			})
		);
	});

	it('discards a user widget draft through the shared lifecycle and records it', async () => {
		const fixture = createFixture();
		const record = createRecord();
		const discarded = {
			type: 'calculator',
			id: widgetId,
			name: record.name,
			publishedVersion: 1,
			draftRevision: 4
		};
		fixture.prisma.calculator.findUnique.mockResolvedValue(record);
		fixture.widgetSettingsService.discardDraft.mockResolvedValue(
			discarded
		);

		await expect(
			fixture.service.discardDraft(
				WidgetType.CALCULATOR,
				widgetId,
				3,
				adminId,
				request
			)
		).resolves.toBe(discarded);
		expect(
			fixture.widgetSettingsService.discardDraft
		).toHaveBeenCalledWith(WidgetType.CALCULATOR, widgetId, ownerId, 3);
		expect(fixture.adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'WIDGET_DRAFT_DISCARD',
				metadata: expect.objectContaining({
					type: WidgetType.CALCULATOR,
					draftRevision: 4
				})
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
				WidgetType.QUIZ,
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
			fixture.service.deleteWidget(WidgetType.QUIZ, widgetId, adminId)
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
