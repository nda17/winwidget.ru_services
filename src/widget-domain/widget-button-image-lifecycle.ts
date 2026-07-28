import { FileService } from '@/file/file.service';
import { PrismaService } from '@/prisma.service';
import { WidgetType } from '@/widget-domain/widget-lifecycle';

interface WidgetButtonImageEntity {
	config: unknown;
	draftConfig: unknown | null;
}

const getButtonImageUrl = (config: unknown) => {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		return '';
	}

	const value = (config as Record<string, unknown>).buttonImageUrl;
	return typeof value === 'string' ? value : '';
};

const findWidgetButtonImageEntity = (
	prisma: PrismaService,
	type: WidgetType,
	widgetId: string
): Promise<WidgetButtonImageEntity | null> => {
	const args = {
		where: { id: widgetId },
		select: { config: true, draftConfig: true }
	};

	switch (type) {
		case WidgetType.WHEEL:
			return prisma.widget.findUnique(args);
		case WidgetType.QUIZ:
			return prisma.quiz.findUnique(args);
		case WidgetType.CALLBACK:
			return prisma.callback.findUnique(args);
		case WidgetType.TIMER:
			return prisma.countdownTimer.findUnique(args);
		case WidgetType.STOP_OFFER:
			return prisma.stopOffer.findUnique(args);
		case WidgetType.ONLINE_CONSULTANT:
			return prisma.onlineConsultant.findUnique(args);
		case WidgetType.CALCULATOR:
			return prisma.calculator.findUnique(args);
	}
};

export const cleanupUnreferencedWidgetButtonImage = async (
	prisma: PrismaService,
	fileService: FileService,
	type: WidgetType,
	widgetId: string,
	imageUrl: unknown
) => {
	if (typeof imageUrl !== 'string' || !imageUrl.trim()) return;

	try {
		const normalizedUrl = imageUrl.trim();
		const entity = await findWidgetButtonImageEntity(
			prisma,
			type,
			widgetId
		);
		if (
			entity &&
			[
				getButtonImageUrl(entity.config),
				getButtonImageUrl(entity.draftConfig)
			]
				.map(value => value.trim())
				.includes(normalizedUrl)
		) {
			return;
		}

		const revisionReference = await prisma.widgetConfigRevision.findFirst({
			where: {
				widgetType: type,
				widgetId,
				config: {
					path: ['buttonImageUrl'],
					equals: normalizedUrl
				}
			},
			select: { id: true }
		});
		if (revisionReference) return;

		await fileService.deleteWidgetButtonImage(normalizedUrl);
	} catch {
		// File cleanup is best-effort and must not turn a committed settings
		// change into a client-visible failure.
	}
};
