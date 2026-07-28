import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { CalculatorService } from '@/calculator/calculator.service';
import type { CallbackService } from '@/callback/callback.service';
import type { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
import type { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import type { PrismaService } from '@/prisma.service';
import type { QuizService } from '@/quiz/quiz.service';
import type { StopOfferService } from '@/stop-offer/stop-offer.service';
import type { SubscriptionService } from '@/subscription/subscription.service';
import { UpdateAdminWidgetDto } from '@/widget-admin/dto/update-admin-widget.dto';
import { WidgetAdminController } from '@/widget-admin/widget-admin.controller';
import { WidgetAdminService } from '@/widget-admin/widget-admin.service';
import type { WidgetService } from '@/widget/widget.service';
import { WidgetType } from '@/widget-domain/widget-lifecycle';
import type { WidgetRuntimeService } from '@/widget-runtime/widget-runtime.service';
import type { WidgetSettingsService } from '@/widget-settings/widget-settings.service';
import { BadRequestException } from '@nestjs/common';
import {
	AuthIdentityType,
	Plan,
	Role,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
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
		const subscriptionService = {
			checkAndResetPeriod: jest.fn().mockResolvedValue({
				plan: Plan.HARD,
				status: SubscriptionStatus.ACTIVE
			}),
			getSubscription: jest.fn()
		};
		const widgetSettingsService = {
			getState: jest.fn().mockResolvedValue({
				type: 'wheel',
				id: widgetId,
				status: 'PUBLISHED'
			}),
			publish: jest.fn(),
			getVersions: jest.fn(),
			restoreVersion: jest.fn(),
			clone: jest.fn(),
			discardDraft: jest.fn()
		};
		const widgetRuntimeService = {
			getStatus: jest.fn(),
			getAnalytics: jest.fn()
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
			subscriptionService as unknown as SubscriptionService,
			widgetSettingsService as unknown as WidgetSettingsService,
			widgetRuntimeService as unknown as WidgetRuntimeService,
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
			subscriptionService,
			widgetSettingsService,
			widgetRuntimeService,
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

	it('returns additive lifecycle and subscription data with the existing entity and owner', async () => {
		const fixture = createFixture();
		fixture.prisma.calculator.findUnique.mockResolvedValue(createRecord());
		const lifecycle = {
			type: 'calculator',
			id: widgetId,
			status: 'CHANGES_PENDING'
		};
		fixture.widgetSettingsService.getState.mockResolvedValue(lifecycle);

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
			},
			ownerStatus: UserStatus.ACTIVE,
			lifecycle,
			ownerPlan: Plan.HARD,
			subscriptionStatus: SubscriptionStatus.ACTIVE
		});
		expect(fixture.widgetSettingsService.getState).toHaveBeenCalledWith(
			WidgetType.CALCULATOR,
			widgetId,
			ownerId
		);
		expect(
			fixture.subscriptionService.checkAndResetPeriod
		).toHaveBeenCalledWith(ownerId);
		expect(
			fixture.subscriptionService.getSubscription
		).not.toHaveBeenCalled();
	});

	it('keeps the stored owner plan available when the owner is deactivated', async () => {
		const fixture = createFixture();
		fixture.prisma.calculator.findUnique.mockResolvedValue({
			...createRecord(),
			user: {
				...createRecord().user,
				status: UserStatus.DEACTIVATED
			}
		});
		fixture.subscriptionService.checkAndResetPeriod.mockResolvedValue(
			null
		);
		fixture.subscriptionService.getSubscription.mockResolvedValue({
			plan: Plan.HARD,
			status: SubscriptionStatus.ACTIVE
		});

		const result = await fixture.service.getWidget(
			WidgetType.CALCULATOR,
			widgetId
		);

		expect(result.ownerPlan).toBe(Plan.HARD);
		expect(result.subscriptionStatus).toBe(SubscriptionStatus.ACTIVE);
		expect(result.ownerStatus).toBe(UserStatus.DEACTIVATED);
		expect(
			fixture.subscriptionService.getSubscription
		).toHaveBeenCalledWith(ownerId);
	});

	it('does not request analytics for a deactivated owner', async () => {
		const fixture = createFixture();
		fixture.prisma.onlineConsultant.findUnique.mockResolvedValue({
			...createRecord(),
			user: {
				...createRecord().user,
				status: UserStatus.DEACTIVATED
			}
		});

		await expect(
			fixture.service.getAnalytics(
				WidgetType.ONLINE_CONSULTANT,
				widgetId,
				30
			)
		).rejects.toThrow('Аналитика недоступна, пока владелец деактивирован');
		expect(
			fixture.widgetRuntimeService.getAnalytics
		).not.toHaveBeenCalled();
	});

	it('delegates versions and runtime reads using the resolved owner', async () => {
		const fixture = createFixture();
		fixture.prisma.onlineConsultant.findUnique.mockResolvedValue(
			createRecord()
		);
		const versions = { items: [], page: 2, limit: 25, total: 0 };
		const runtimeStatus = { installation: { state: 'SIGNAL_RECEIVED' } };
		const analytics = { days: 14, totals: { impressions: 10 } };
		fixture.widgetSettingsService.getVersions.mockResolvedValue(versions);
		fixture.widgetRuntimeService.getStatus.mockResolvedValue(
			runtimeStatus
		);
		fixture.widgetRuntimeService.getAnalytics.mockResolvedValue(analytics);

		await expect(
			fixture.service.getVersions(
				WidgetType.ONLINE_CONSULTANT,
				widgetId,
				2,
				25
			)
		).resolves.toBe(versions);
		await expect(
			fixture.service.getRuntimeStatus(
				WidgetType.ONLINE_CONSULTANT,
				widgetId
			)
		).resolves.toBe(runtimeStatus);
		await expect(
			fixture.service.getAnalytics(
				WidgetType.ONLINE_CONSULTANT,
				widgetId,
				14
			)
		).resolves.toBe(analytics);

		expect(fixture.widgetSettingsService.getVersions).toHaveBeenCalledWith(
			WidgetType.ONLINE_CONSULTANT,
			widgetId,
			ownerId,
			2,
			25
		);
		expect(fixture.widgetRuntimeService.getStatus).toHaveBeenCalledWith(
			ownerId,
			'online-consultant',
			widgetId
		);
		expect(fixture.widgetRuntimeService.getAnalytics).toHaveBeenCalledWith(
			ownerId,
			'online-consultant',
			widgetId,
			14
		);
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();
	});

	it('restores a version through the owner lifecycle and audits success', async () => {
		const fixture = createFixture();
		fixture.prisma.quiz.findUnique.mockResolvedValue(createRecord());
		const restored = {
			type: 'quiz',
			id: widgetId,
			name: 'Старое имя',
			draftRevision: 6
		};
		fixture.widgetSettingsService.restoreVersion.mockResolvedValue(
			restored
		);

		await expect(
			fixture.service.restoreVersion(
				WidgetType.QUIZ,
				widgetId,
				4,
				5,
				adminId,
				request
			)
		).resolves.toBe(restored);
		expect(
			fixture.widgetSettingsService.restoreVersion
		).toHaveBeenCalledWith(WidgetType.QUIZ, widgetId, 4, ownerId, 5);
		expect(fixture.adminEventLogService.record).toHaveBeenCalledWith({
			adminId,
			section: 'WIDGETS',
			action: 'WIDGET_VERSION_RESTORE',
			description:
				'Восстановлена версия 4 пользовательского виджета «Старое имя»',
			entityType: 'widget',
			entityId: widgetId,
			entityLabel: 'Старое имя',
			targetUserId: ownerId,
			metadata: {
				type: WidgetType.QUIZ,
				id: widgetId,
				ownerId,
				version: 4,
				draftRevision: 6
			},
			request
		});
	});

	it('clones through the owner lifecycle and audits only non-secret identifiers', async () => {
		const fixture = createFixture();
		fixture.prisma.widget.findUnique.mockResolvedValue(createRecord());
		const cloned = {
			id: 'cloned-widget-id',
			type: 'wheel',
			name: 'Копия'
		};
		fixture.widgetSettingsService.clone.mockResolvedValue(cloned);

		await expect(
			fixture.service.cloneWidget(
				WidgetType.WHEEL,
				widgetId,
				'Копия',
				adminId,
				request
			)
		).resolves.toBe(cloned);
		expect(fixture.widgetSettingsService.clone).toHaveBeenCalledWith(
			WidgetType.WHEEL,
			widgetId,
			ownerId,
			'Копия'
		);
		expect(fixture.adminEventLogService.record).toHaveBeenCalledWith({
			adminId,
			section: 'WIDGETS',
			action: 'WIDGET_CLONE',
			description:
				'Клонирован пользовательский виджет «Старое имя» как «Копия»',
			entityType: 'widget',
			entityId: 'cloned-widget-id',
			entityLabel: 'Копия',
			targetUserId: ownerId,
			metadata: {
				type: WidgetType.WHEEL,
				id: 'cloned-widget-id',
				sourceId: widgetId,
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
	});

	it('does not audit a failed version restore or clone', async () => {
		const fixture = createFixture();
		fixture.prisma.callback.findUnique.mockResolvedValue(createRecord());
		fixture.widgetSettingsService.restoreVersion.mockRejectedValue(
			new BadRequestException('Версия не восстановлена')
		);

		await expect(
			fixture.service.restoreVersion(
				WidgetType.CALLBACK,
				widgetId,
				2,
				3,
				adminId
			)
		).rejects.toThrow('Версия не восстановлена');
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();

		fixture.widgetSettingsService.clone.mockRejectedValue(
			new BadRequestException('Клон не создан')
		);
		await expect(
			fixture.service.cloneWidget(
				WidgetType.CALLBACK,
				widgetId,
				undefined,
				adminId
			)
		).rejects.toThrow('Клон не создан');
		expect(fixture.adminEventLogService.record).not.toHaveBeenCalled();
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

describe('WidgetAdminController settings delegation', () => {
	const widgetId = 'widget-id';
	const adminId = 'admin-id';
	const request = {} as Request;

	const createController = () => {
		const service = {
			getVersions: jest.fn(),
			restoreVersion: jest.fn(),
			cloneWidget: jest.fn(),
			getRuntimeStatus: jest.fn(),
			getAnalytics: jest.fn()
		};

		return {
			controller: new WidgetAdminController(
				service as unknown as WidgetAdminService
			),
			service
		};
	};

	it('exposes the dedicated admin settings routes', () => {
		const prototype = WidgetAdminController.prototype;

		expect(Reflect.getMetadata('path', prototype.getVersions)).toBe(
			':type/:id/versions'
		);
		expect(Reflect.getMetadata('path', prototype.restoreVersion)).toBe(
			':type/:id/versions/:version/restore'
		);
		expect(Reflect.getMetadata('path', prototype.cloneWidget)).toBe(
			':type/:id/clone'
		);
		expect(Reflect.getMetadata('path', prototype.getRuntimeStatus)).toBe(
			':type/:id/runtime-status'
		);
		expect(Reflect.getMetadata('path', prototype.getAnalytics)).toBe(
			':type/:id/analytics'
		);
	});

	it('normalizes read query values before service delegation', () => {
		const { controller, service } = createController();

		controller.getVersions(WidgetType.TIMER, widgetId, '2', '25');
		controller.getRuntimeStatus(WidgetType.TIMER, widgetId);
		controller.getAnalytics(WidgetType.TIMER, widgetId, '14');

		expect(service.getVersions).toHaveBeenCalledWith(
			WidgetType.TIMER,
			widgetId,
			2,
			25
		);
		expect(service.getRuntimeStatus).toHaveBeenCalledWith(
			WidgetType.TIMER,
			widgetId
		);
		expect(service.getAnalytics).toHaveBeenCalledWith(
			WidgetType.TIMER,
			widgetId,
			14
		);
	});

	it('passes admin identity and request to restore and clone mutations', () => {
		const { controller, service } = createController();

		controller.restoreVersion(
			WidgetType.WHEEL,
			widgetId,
			4,
			{ expectedDraftRevision: 3 },
			adminId,
			request
		);
		controller.cloneWidget(
			WidgetType.WHEEL,
			widgetId,
			{ name: 'Копия' },
			adminId,
			request
		);

		expect(service.restoreVersion).toHaveBeenCalledWith(
			WidgetType.WHEEL,
			widgetId,
			4,
			3,
			adminId,
			request
		);
		expect(service.cloneWidget).toHaveBeenCalledWith(
			WidgetType.WHEEL,
			widgetId,
			'Копия',
			adminId,
			request
		);
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
