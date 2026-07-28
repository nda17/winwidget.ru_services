import { ConflictException } from '@nestjs/common';

export enum WidgetType {
	WHEEL = 'WHEEL',
	QUIZ = 'QUIZ',
	CALLBACK = 'CALLBACK',
	TIMER = 'TIMER',
	STOP_OFFER = 'STOP_OFFER',
	ONLINE_CONSULTANT = 'ONLINE_CONSULTANT',
	CALCULATOR = 'CALCULATOR'
}

export type WidgetTypeSlug =
	| 'wheel'
	| 'quiz'
	| 'callback'
	| 'timer'
	| 'stop-offer'
	| 'online-consultant'
	| 'calculator';

export type WidgetLifecycleStatus =
	| 'DRAFT_ONLY'
	| 'CHANGES_PENDING'
	| 'INACTIVE'
	| 'PUBLISHED';

export interface WidgetLifecycleEntity {
	id: string;
	userId: string;
	publicKey: string;
	name: string;
	isActive: boolean;
	installDomain: string;
	config: unknown;
	draftConfig?: unknown | null;
	draftInstallDomain?: string | null;
	draftRevision?: number;
	publishedVersion?: number;
	publishedFromDraftRevision?: number;
	publishedAt?: Date | null;
	createdAt: Date;
	updatedAt: Date;
	[key: string]: unknown;
}

const WIDGET_TYPES_BY_SLUG: Record<WidgetTypeSlug, WidgetType> = {
	wheel: WidgetType.WHEEL,
	quiz: WidgetType.QUIZ,
	callback: WidgetType.CALLBACK,
	timer: WidgetType.TIMER,
	'stop-offer': WidgetType.STOP_OFFER,
	'online-consultant': WidgetType.ONLINE_CONSULTANT,
	calculator: WidgetType.CALCULATOR
};

const WIDGET_TYPE_SLUGS: Record<WidgetType, WidgetTypeSlug> = {
	[WidgetType.WHEEL]: 'wheel',
	[WidgetType.QUIZ]: 'quiz',
	[WidgetType.CALLBACK]: 'callback',
	[WidgetType.TIMER]: 'timer',
	[WidgetType.STOP_OFFER]: 'stop-offer',
	[WidgetType.ONLINE_CONSULTANT]: 'online-consultant',
	[WidgetType.CALCULATOR]: 'calculator'
};

export const parseWidgetTypeSlug = (value: string): WidgetType | null =>
	WIDGET_TYPES_BY_SLUG[value as WidgetTypeSlug] ?? null;

export const widgetTypeToSlug = (type: WidgetType): WidgetTypeSlug =>
	WIDGET_TYPE_SLUGS[type];

export const getWidgetDraftConfig = (entity: WidgetLifecycleEntity) =>
	entity.draftConfig ?? entity.config;

export const getWidgetDraftInstallDomain = (
	entity: WidgetLifecycleEntity
): string => entity.draftInstallDomain ?? entity.installDomain;

export const hasWidgetUnpublishedChanges = (
	entity: WidgetLifecycleEntity
): boolean =>
	(entity.publishedVersion ?? 0) === 0 ||
	(entity.draftRevision ?? 0) !== (entity.publishedFromDraftRevision ?? 0);

export const getWidgetLifecycleStatus = (
	entity: WidgetLifecycleEntity
): WidgetLifecycleStatus => {
	if ((entity.publishedVersion ?? 0) === 0) return 'DRAFT_ONLY';
	if (hasWidgetUnpublishedChanges(entity)) return 'CHANGES_PENDING';
	if (!entity.isActive) return 'INACTIVE';
	return 'PUBLISHED';
};

export const projectWidgetDraft = <T extends WidgetLifecycleEntity>(
	entity: T
) => {
	const rest = { ...entity };
	delete rest.draftConfig;
	delete rest.draftInstallDomain;

	return {
		...rest,
		config: getWidgetDraftConfig(entity),
		installDomain: getWidgetDraftInstallDomain(entity),
		draftRevision: entity.draftRevision ?? 0,
		publishedVersion: entity.publishedVersion ?? 0,
		publishedFromDraftRevision: entity.publishedFromDraftRevision ?? 0,
		publishedAt: entity.publishedAt ?? null,
		status: getWidgetLifecycleStatus(entity),
		hasUnpublishedChanges: hasWidgetUnpublishedChanges(entity)
	};
};

export const assertExpectedDraftRevision = (
	entity: WidgetLifecycleEntity,
	expectedDraftRevision: number | undefined
) => {
	if (expectedDraftRevision === undefined) {
		throw new ConflictException(
			'Настройки изменились. Обновите страницу и повторите действие'
		);
	}

	if ((entity.draftRevision ?? 0) !== expectedDraftRevision) {
		throw new ConflictException(
			'Настройки уже изменены в другой сессии. Обновите страницу'
		);
	}
};
