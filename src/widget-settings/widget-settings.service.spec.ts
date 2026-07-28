import { CalculatorService } from '@/calculator/calculator.service';
import { CallbackService } from '@/callback/callback.service';
import { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import { QuizService } from '@/quiz/quiz.service';
import { StopOfferService } from '@/stop-offer/stop-offer.service';
import { WidgetService } from '@/widget/widget.service';
import {
	WidgetType,
	WidgetTypeSlug
} from '@/widget-domain/widget-lifecycle';
import { WidgetSettingsService } from '@/widget-settings/widget-settings.service';
import { ConflictException } from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';

const CREATED_AT = new Date('2026-07-27T10:00:00.000Z');
const UPDATED_AT = new Date('2026-07-27T11:00:00.000Z');
const PUBLISHED_AT = new Date('2026-07-27T10:30:00.000Z');

const WIDGET_CASES: Array<{
	type: WidgetType;
	slug: WidgetTypeSlug;
	delegate:
		| 'widget'
		| 'quiz'
		| 'callback'
		| 'countdownTimer'
		| 'stopOffer'
		| 'onlineConsultant'
		| 'calculator';
}> = [
	{ type: WidgetType.WHEEL, slug: 'wheel', delegate: 'widget' },
	{ type: WidgetType.QUIZ, slug: 'quiz', delegate: 'quiz' },
	{ type: WidgetType.CALLBACK, slug: 'callback', delegate: 'callback' },
	{ type: WidgetType.TIMER, slug: 'timer', delegate: 'countdownTimer' },
	{
		type: WidgetType.STOP_OFFER,
		slug: 'stop-offer',
		delegate: 'stopOffer'
	},
	{
		type: WidgetType.ONLINE_CONSULTANT,
		slug: 'online-consultant',
		delegate: 'onlineConsultant'
	},
	{
		type: WidgetType.CALCULATOR,
		slug: 'calculator',
		delegate: 'calculator'
	}
];
const IMAGE_WIDGET_CASES = WIDGET_CASES.filter(
	widgetCase => widgetCase.type !== WidgetType.STOP_OFFER
);

const createEntity = () => ({
	id: 'widget-id',
	userId: 'user-id',
	publicKey: 'public-key',
	name: 'Тестовый виджет',
	isActive: true,
	installDomain: 'published.example.test',
	config: { title: 'Опубликовано' } as Record<string, unknown>,
	draftInstallDomain: 'draft.example.test',
	draftConfig: {
		title: 'Черновик',
		items: [{ id: 1 }]
	} as Record<string, unknown>,
	draftRevision: 2,
	publishedVersion: 1,
	publishedFromDraftRevision: 1,
	publishedAt: PUBLISHED_AT,
	createdAt: CREATED_AT,
	updatedAt: UPDATED_AT
});

const applyMutation = (
	entity: Record<string, any>,
	data: Record<string, any>
) => {
	Object.entries(data).forEach(([field, value]) => {
		if (value && typeof value === 'object' && 'increment' in value) {
			entity[field] = Number(entity[field] ?? 0) + Number(value.increment);
			return;
		}
		entity[field] = value;
	});
	entity.updatedAt = new Date('2026-07-27T12:00:00.000Z');
};

const createFixture = () => {
	let entity = createEntity();
	const revisions = [
		{
			id: 'revision-1',
			widgetType: WidgetType.WHEEL,
			widgetId: entity.id,
			version: 1,
			config: { title: 'Версия 1' },
			installDomain: 'version-1.example.test',
			sourceVersion: null,
			createdAt: PUBLISHED_AT
		}
	];

	const createDelegate = () => ({
		findUnique: jest.fn(async () => ({ ...entity })),
		findFirst: jest.fn(
			async ({ where }: { where: { id: string; userId: string } }) =>
				where.id === entity.id && where.userId === entity.userId
					? { ...entity }
					: null
		),
		updateMany: jest.fn(
			async ({
				where,
				data
			}: {
				where: Record<string, any>;
				data: Record<string, any>;
			}) => {
				if (
					where.id !== entity.id ||
					where.userId !== entity.userId ||
					(where.draftRevision !== undefined &&
						where.draftRevision !== entity.draftRevision) ||
					(where.publishedVersion !== undefined &&
						where.publishedVersion !== entity.publishedVersion)
				) {
					return { count: 0 };
				}
				applyMutation(entity, data);
				return { count: 1 };
			}
		),
		create: jest.fn(async ({ data }: { data: Record<string, any> }) => ({
			...createEntity(),
			...data,
			id: 'cloned-widget-id',
			createdAt: CREATED_AT,
			updatedAt: UPDATED_AT
		}))
	});

	const delegates = Object.fromEntries(
		WIDGET_CASES.map(({ delegate }) => [delegate, createDelegate()])
	);
	const widgetConfigRevision = {
		create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
			const revision = {
				id: `revision-${data.version}`,
				sourceVersion: null,
				createdAt: UPDATED_AT,
				...data
			};
			revisions.push(revision as (typeof revisions)[number]);
			return revision;
		}),
		findUnique: jest.fn(
			async ({
				where
			}: {
				where: {
					widgetType_widgetId_version: {
						widgetType: WidgetType;
						widgetId: string;
						version: number;
					};
				};
			}) => {
				const key = where.widgetType_widgetId_version;
				return (
					revisions.find(
						revision =>
							revision.widgetType === key.widgetType &&
							revision.widgetId === key.widgetId &&
							revision.version === key.version
					) ?? null
				);
			}
		),
		findMany: jest.fn(async () =>
			revisions.map(({ version, sourceVersion, createdAt }) => ({
				version,
				sourceVersion,
				createdAt
			}))
		),
		findFirst: jest.fn(async () => null),
		count: jest.fn(async () => revisions.length)
	};
	const prisma: Record<string, any> = {
		...delegates,
		widgetConfigRevision
	};
	prisma.$transaction = jest.fn(
		async (
			operation:
				| Array<Promise<unknown>>
				| ((transaction: typeof prisma) => Promise<unknown>)
		) =>
			typeof operation === 'function'
				? operation(prisma)
				: Promise.all(operation)
	);

	const subscriptionService = {
		createWidgetWithinLimit: jest.fn(
			async (
				_userId: string,
				createWidget: (transaction: typeof prisma) => Promise<unknown>
			) => createWidget(prisma)
		)
	};
	const fileService = {
		deleteWidgetButtonImage: jest.fn().mockResolvedValue(undefined)
	};

	return {
		service: new WidgetSettingsService(
			prisma as never,
			subscriptionService as never,
			fileService as never
		),
		prisma,
		widgetConfigRevision,
		fileService,
		getEntity: () => entity,
		setEntity: (nextEntity: typeof entity) => {
			entity = nextEntity;
		}
	};
};

const updateWidgetDraft = (
	type: WidgetType,
	prisma: Record<string, any>
) => {
	const commonDependencies = [
		prisma as never,
		{} as never,
		{} as never,
		{} as never
	] as const;
	const dto = {
		installDomain: 'https://draft.example.test/settings',
		expectedDraftRevision: 2
	};

	switch (type) {
		case WidgetType.WHEEL:
			return new WidgetService(...commonDependencies).updateWidget(
				'user-id',
				'widget-id',
				dto
			);
		case WidgetType.QUIZ:
			return new QuizService(...commonDependencies).updateQuiz(
				'user-id',
				'widget-id',
				dto
			);
		case WidgetType.CALLBACK:
			return new CallbackService(...commonDependencies).updateCallback(
				'user-id',
				'widget-id',
				dto
			);
		case WidgetType.TIMER:
			return new CountdownTimerService(
				...commonDependencies
			).updateCountdownTimer('user-id', 'widget-id', dto);
		case WidgetType.STOP_OFFER:
			return new StopOfferService(
				commonDependencies[0],
				commonDependencies[1],
				commonDependencies[3]
			).updateStopOffer('user-id', 'widget-id', dto);
		case WidgetType.ONLINE_CONSULTANT:
			return new OnlineConsultantService(
				...commonDependencies
			).updateOnlineConsultant('user-id', 'widget-id', dto);
		case WidgetType.CALCULATOR:
			return new CalculatorService(...commonDependencies).updateCalculator(
				'user-id',
				'widget-id',
				dto
			);
	}
};

const uploadWidgetButtonImage = (
	type: WidgetType,
	prisma: Record<string, any>,
	subscriptionService: Record<string, any>,
	fileService: Record<string, any>,
	expectedDraftRevision: number
) => {
	const dependencies = [
		prisma as never,
		subscriptionService as never,
		fileService as never,
		{} as never
	] as const;
	const file = { originalname: 'button.png' } as Express.Multer.File;

	switch (type) {
		case WidgetType.WHEEL:
			return new WidgetService(...dependencies).uploadButtonImage(
				'user-id',
				'widget-id',
				file,
				expectedDraftRevision
			);
		case WidgetType.QUIZ:
			return new QuizService(...dependencies).uploadButtonImage(
				'user-id',
				'widget-id',
				file,
				expectedDraftRevision
			);
		case WidgetType.CALLBACK:
			return new CallbackService(...dependencies).uploadButtonImage(
				'user-id',
				'widget-id',
				file,
				expectedDraftRevision
			);
		case WidgetType.TIMER:
			return new CountdownTimerService(...dependencies).uploadButtonImage(
				'user-id',
				'widget-id',
				file,
				expectedDraftRevision
			);
		case WidgetType.ONLINE_CONSULTANT:
			return new OnlineConsultantService(
				...dependencies
			).uploadButtonImage(
				'user-id',
				'widget-id',
				file,
				expectedDraftRevision
			);
		case WidgetType.CALCULATOR:
			return new CalculatorService(...dependencies).uploadButtonImage(
				'user-id',
				'widget-id',
				file,
				expectedDraftRevision
			);
		case WidgetType.STOP_OFFER:
			throw new Error('Стоп-оффер не поддерживает картинку кнопки');
	}
};

describe('WidgetSettingsService', () => {
	it.each(WIDGET_CASES)(
		'returns the draft projection and lifecycle state for $slug',
		async ({ type, slug }) => {
			const fixture = createFixture();

			await expect(
				fixture.service.getState(type, 'widget-id', 'user-id')
			).resolves.toMatchObject({
				type: slug,
				id: 'widget-id',
				installDomain: 'draft.example.test',
				config: { title: 'Черновик' },
				draftRevision: 2,
				publishedVersion: 1,
				publishedFromDraftRevision: 1,
				status: 'CHANGES_PENDING',
				hasUnpublishedChanges: true,
				readiness: {
					ready: true,
					blockers: []
				}
			});
		}
	);

	it.each(WIDGET_CASES)(
		'publishes an immutable next version for $slug',
		async ({ type, delegate }) => {
			const fixture = createFixture();

			const state = await fixture.service.publish(
				type,
				'widget-id',
				'user-id',
				2
			);

			expect(fixture.widgetConfigRevision.create).toHaveBeenCalledWith({
				data: {
					widgetType: type,
					widgetId: 'widget-id',
					version: 2,
					config: { title: 'Черновик', items: [{ id: 1 }] },
					installDomain: 'draft.example.test'
				}
			});
			expect(fixture.prisma[delegate].updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						draftRevision: 2,
						publishedVersion: 1
					})
				})
			);
			expect(state).toMatchObject({
				publishedVersion: 2,
				publishedFromDraftRevision: 2,
				status: 'PUBLISHED',
				hasUnpublishedChanges: false
			});
			expect(fixture.getEntity()).toMatchObject({
				config: { title: 'Черновик', items: [{ id: 1 }] },
				installDomain: 'draft.example.test'
			});
		}
	);

	it.each(WIDGET_CASES)(
		'restores a published version into the draft for $slug',
		async ({ type }) => {
			const fixture = createFixture();
			fixture.widgetConfigRevision.findUnique.mockResolvedValueOnce({
				id: 'revision-1',
				widgetType: type,
				widgetId: 'widget-id',
				version: 1,
				config: { title: 'Версия 1' },
				installDomain: 'version-1.example.test',
				sourceVersion: null,
				createdAt: PUBLISHED_AT
			});

			const state = await fixture.service.restoreVersion(
				type,
				'widget-id',
				1,
				'user-id',
				2
			);

			expect(state).toMatchObject({
				config: { title: 'Версия 1' },
				installDomain: 'version-1.example.test',
				draftRevision: 3,
				status: 'CHANGES_PENDING'
			});
		}
	);

	it.each(WIDGET_CASES)(
		'discards draft changes for $slug',
		async ({ type }) => {
			const fixture = createFixture();

			const state = await fixture.service.discardDraft(
				type,
				'widget-id',
				'user-id',
				2
			);

			expect(state).toMatchObject({
				config: { title: 'Опубликовано' },
				installDomain: 'published.example.test',
				draftRevision: 3,
				publishedFromDraftRevision: 3,
				status: 'PUBLISHED',
				hasUnpublishedChanges: false
			});
		}
	);

	it.each(WIDGET_CASES)(
		'clones $slug as an inactive unpublished draft',
		async ({ type, slug, delegate }) => {
			const fixture = createFixture();

			await expect(
				fixture.service.clone(type, 'widget-id', 'user-id', 'Копия')
			).resolves.toEqual({
				id: 'cloned-widget-id',
				type: slug,
				name: 'Копия'
			});
			expect(fixture.prisma[delegate].create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					isActive: false,
					draftRevision: 1,
					publishedVersion: 0,
					publishedFromDraftRevision: 0,
					publishedAt: null,
					draftInstallDomain: 'draft.example.test'
				})
			});
		}
	);

	it('returns only safe revision metadata', async () => {
		const fixture = createFixture();

		const result = await fixture.service.getVersions(
			WidgetType.WHEEL,
			'widget-id',
			'user-id'
		);

		expect(fixture.widgetConfigRevision.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				select: {
					version: true,
					sourceVersion: true,
					createdAt: true
				}
			})
		);
		expect(result.items[0]).not.toHaveProperty('config');
		expect(result.items[0]).not.toHaveProperty('installDomain');
	});

	it('rejects stale draft revisions', async () => {
		const fixture = createFixture();

		await expect(
			fixture.service.publish(WidgetType.WHEEL, 'widget-id', 'user-id', 1)
		).rejects.toBeInstanceOf(ConflictException);
		expect(fixture.widgetConfigRevision.create).not.toHaveBeenCalled();
	});

	it('cleans up an unpublished image after discarding the draft', async () => {
		const fixture = createFixture();
		fixture.setEntity({
			...createEntity(),
			config: { title: 'Опубликовано', buttonImageUrl: '' },
			draftConfig: {
				title: 'Черновик',
				buttonImageUrl: '/uploads/widget-buttons/wheel/widget-id/draft.png'
			}
		});

		await fixture.service.discardDraft(
			WidgetType.WHEEL,
			'widget-id',
			'user-id',
			2
		);

		expect(
			fixture.fileService.deleteWidgetButtonImage
		).toHaveBeenCalledWith(
			'/uploads/widget-buttons/wheel/widget-id/draft.png'
		);
	});

	it.each(WIDGET_CASES)(
		'saves $slug settings to the draft without changing the published snapshot',
		async ({ type, delegate }) => {
			const entity = createEntity();
			const persistence = {
				findUnique: jest.fn(async () => ({ ...entity })),
				findUniqueOrThrow: jest.fn(async () => ({ ...entity })),
				update: jest.fn(),
				updateMany: jest.fn(
					async ({ data }: { data: Record<string, any> }) => {
						applyMutation(entity, data);
						return { count: 1 };
					}
				)
			};
			const prisma = { [delegate]: persistence };

			const updated = await updateWidgetDraft(type, prisma);

			expect(persistence.updateMany).toHaveBeenCalledWith({
				where: {
					id: 'widget-id',
					userId: 'user-id',
					draftRevision: 2
				},
				data: expect.objectContaining({
					draftInstallDomain: 'example.test',
					draftRevision: { increment: 1 }
				})
			});
			expect(entity).toMatchObject({
				installDomain: 'published.example.test',
				config: { title: 'Опубликовано' },
				draftInstallDomain: 'example.test',
				draftRevision: 3
			});
			expect(updated).toMatchObject({
				installDomain: 'example.test',
				draftRevision: 3,
				hasUnpublishedChanges: true
			});
		}
	);

	it.each(IMAGE_WIDGET_CASES)(
		'uses draft CAS while uploading a $slug button image',
		async ({ type, delegate }) => {
			const entity = {
				...createEntity(),
				draftConfig: {
					title: 'Черновик',
					buttonImageUrl: '/uploads/widget-buttons/old-button.png'
				}
			};
			const persistence = {
				findUnique: jest.fn(async () => ({ ...entity })),
				findUniqueOrThrow: jest.fn(async () => ({ ...entity })),
				updateMany: jest.fn(
					async ({
						where,
						data
					}: {
						where: Record<string, any>;
						data: Record<string, any>;
					}) => {
						if (where.draftRevision !== entity.draftRevision) {
							return { count: 0 };
						}
						applyMutation(entity, data);
						return { count: 1 };
					}
				)
			};
			const prisma: Record<string, any> = {
				[delegate]: persistence,
				widgetConfigRevision: {
					findFirst: jest.fn().mockResolvedValue(null)
				}
			};
			prisma.$transaction = jest.fn(
				async (operation: (transaction: typeof prisma) => unknown) =>
					operation(prisma)
			);
			const subscriptionService = {
				checkAndResetPeriod: jest.fn().mockResolvedValue({
					status: SubscriptionStatus.ACTIVE,
					plan: Plan.HARD
				})
			};
			const fileService = {
				saveWidgetButtonImage: jest.fn().mockResolvedValue({
					url: '/uploads/widget-buttons/new-button.png'
				}),
				deleteWidgetButtonImage: jest.fn().mockResolvedValue(undefined)
			};

			const updated = await uploadWidgetButtonImage(
				type,
				prisma,
				subscriptionService,
				fileService,
				2
			);

			expect(persistence.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						id: 'widget-id',
						userId: 'user-id',
						draftRevision: 2
					}
				})
			);
			expect(updated).toMatchObject({
				draftRevision: 3,
				config: {
					buttonImageUrl: '/uploads/widget-buttons/new-button.png'
				}
			});
			expect(fileService.deleteWidgetButtonImage).toHaveBeenCalledWith(
				'/uploads/widget-buttons/old-button.png'
			);
		}
	);
});
