import { cleanupUnreferencedWidgetButtonImage } from '@/widget-domain/widget-button-image-lifecycle';
import { WidgetType } from '@/widget-domain/widget-lifecycle';

const IMAGE_URL = '/uploads/widget-buttons/wheel/widget-id/old-image.png';

const TYPES = [
	{ type: WidgetType.WHEEL, delegate: 'widget' },
	{ type: WidgetType.QUIZ, delegate: 'quiz' },
	{ type: WidgetType.CALLBACK, delegate: 'callback' },
	{ type: WidgetType.TIMER, delegate: 'countdownTimer' },
	{
		type: WidgetType.ONLINE_CONSULTANT,
		delegate: 'onlineConsultant'
	},
	{ type: WidgetType.CALCULATOR, delegate: 'calculator' }
] as const;

const createFixture = () => {
	const createDelegate = () => ({
		findUnique: jest.fn().mockResolvedValue({
			config: { buttonImageUrl: '' },
			draftConfig: { buttonImageUrl: '' }
		})
	});
	const prisma = {
		widget: createDelegate(),
		quiz: createDelegate(),
		callback: createDelegate(),
		countdownTimer: createDelegate(),
		stopOffer: createDelegate(),
		onlineConsultant: createDelegate(),
		calculator: createDelegate(),
		widgetConfigRevision: {
			findFirst: jest.fn().mockResolvedValue(null)
		}
	};
	const fileService = {
		deleteWidgetButtonImage: jest.fn().mockResolvedValue(undefined)
	};

	return { prisma, fileService };
};

describe('cleanupUnreferencedWidgetButtonImage', () => {
	it.each(TYPES)(
		'deletes an unreferenced $type asset',
		async ({ type, delegate }) => {
			const fixture = createFixture();

			await cleanupUnreferencedWidgetButtonImage(
				fixture.prisma as never,
				fixture.fileService as never,
				type,
				'widget-id',
				IMAGE_URL
			);

			expect(fixture.prisma[delegate].findUnique).toHaveBeenCalled();
			expect(
				fixture.fileService.deleteWidgetButtonImage
			).toHaveBeenCalledWith(IMAGE_URL);
		}
	);

	it('keeps an asset referenced by the current published snapshot', async () => {
		const fixture = createFixture();
		fixture.prisma.widget.findUnique.mockResolvedValue({
			config: { buttonImageUrl: IMAGE_URL },
			draftConfig: { buttonImageUrl: '' }
		});

		await cleanupUnreferencedWidgetButtonImage(
			fixture.prisma as never,
			fixture.fileService as never,
			WidgetType.WHEEL,
			'widget-id',
			IMAGE_URL
		);

		expect(
			fixture.prisma.widgetConfigRevision.findFirst
		).not.toHaveBeenCalled();
		expect(
			fixture.fileService.deleteWidgetButtonImage
		).not.toHaveBeenCalled();
	});

	it('keeps an asset referenced by immutable history', async () => {
		const fixture = createFixture();
		fixture.prisma.widgetConfigRevision.findFirst.mockResolvedValue({
			id: 'revision-id'
		});

		await cleanupUnreferencedWidgetButtonImage(
			fixture.prisma as never,
			fixture.fileService as never,
			WidgetType.WHEEL,
			'widget-id',
			IMAGE_URL
		);

		expect(
			fixture.fileService.deleteWidgetButtonImage
		).not.toHaveBeenCalled();
	});

	it('does not fail a committed settings change when cleanup lookup fails', async () => {
		const fixture = createFixture();
		fixture.prisma.widget.findUnique.mockRejectedValue(
			new Error('temporary database error')
		);

		await expect(
			cleanupUnreferencedWidgetButtonImage(
				fixture.prisma as never,
				fixture.fileService as never,
				WidgetType.WHEEL,
				'widget-id',
				IMAGE_URL
			)
		).resolves.toBeUndefined();
		expect(
			fixture.fileService.deleteWidgetButtonImage
		).not.toHaveBeenCalled();
	});
});
