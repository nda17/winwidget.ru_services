import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/widgets-client';
import type {
	CreateLeadData,
	WidgetLeadRecord
} from './widgets-domain.repository';
import { asJsonObject, WidgetType } from './widgets-domain.types';

export interface WidgetLeadInput {
	contact?: string;
	name?: string;
	phone?: string;
	email?: string;
	bonus?: string;
	answers?: unknown[];
	result?: string;
	timeSlot?: string;
	timezone?: string;
	actionLabel?: string;
	actionValue?: string;
	url?: string;
	challengeId?: string;
	code?: string;
}

export interface PreparedWidgetLead {
	data: CreateLeadData;
	response?: Record<string, unknown>;
}

export interface DuplicateLeadLookup {
	contact?: string;
	phone?: string;
	email?: string;
	ip?: string;
	resetToken?: string;
	since?: Date;
}

export interface DuplicateLeadRule {
	lookup: DuplicateLeadLookup;
	message: string;
}

export interface PublicDuplicateRule {
	responseKey: 'hasPlayedByIp' | 'hasSubmittedByIp';
	lookup: DuplicateLeadLookup;
}

export interface WidgetPublicContext {
	publishedVersion: number;
	hardPlan: boolean;
	duplicateByIp: boolean;
}

export interface WidgetExportSpec {
	filenamePrefix: string;
	headers: string[];
	xlsxHeaders?: string[];
	rows: unknown[][];
}

export type WidgetStatsAggregate =
	| {
			kind: 'grouped';
			total: number;
			groups: Array<{
				value: string | null;
				count: number;
			}>;
	  }
	| {
			kind: 'calculator';
			total: number;
			min: Prisma.Decimal | null;
			max: Prisma.Decimal | null;
			average: Prisma.Decimal | null;
	  }
	| {
			kind: 'unsupported';
	  };

export interface WidgetTypeAdapter {
	readonly type: WidgetType;
	publicConfig(
		config: Record<string, unknown>,
		context: WidgetPublicContext
	): Record<string, unknown>;
	prepareLead(
		input: WidgetLeadInput,
		config: Record<string, unknown>
	): PreparedWidgetLead;
	duplicateRules(
		prepared: CreateLeadData,
		config: Record<string, unknown>,
		ip: string
	): DuplicateLeadRule[];
	publicDuplicateRule(
		config: Record<string, unknown>,
		ip: string
	): PublicDuplicateRule | null;
	presentLead(
		lead: WidgetLeadRecord,
		config: Record<string, unknown>
	): WidgetLeadRecord;
	stats(
		aggregate: WidgetStatsAggregate,
		config: Record<string, unknown>
	): Record<string, unknown> | null;
	exportSpec(
		leads: WidgetLeadRecord[],
		config: Record<string, unknown>
	): WidgetExportSpec;
}

export const stringValue = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback;

export const numberValue = (value: unknown, fallback: number): number => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

export const integrationPublicFields = (
	config: Record<string, unknown>
) => {
	const integrations = asJsonObject(config.integrations);
	return {
		yandexMetrikaId:
			typeof integrations.yandexMetrikaId === 'string'
				? integrations.yandexMetrikaId || null
				: null,
		vkPixelId:
			typeof integrations.vkPixelId === 'string'
				? integrations.vkPixelId || null
				: null,
		roistatEnabled: integrations.roistatEnabled === true
	};
};

export const brandingPublicFields = (
	config: Record<string, unknown>,
	hardPlan: boolean
) => ({
	buttonImageUrl:
		hardPlan && isManagedWidgetButtonImage(config.buttonImageUrl)
			? config.buttonImageUrl.trim()
			: '',
	hideBranding: hardPlan,
	developInfoActive: config.developInfoActive !== false && !hardPlan
});

const isManagedWidgetButtonImage = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.trim().length > 0 &&
	value.includes('/widget-buttons/');

export const buttonPublicFields = (
	config: Record<string, unknown>,
	hardPlan: boolean
) => ({
	buttonColor: stringValue(config.buttonColor),
	openButtonColor: stringValue(config.openButtonColor),
	buttonSide: stringValue(config.buttonSide, 'right'),
	buttonPulse: config.buttonPulse !== false,
	buttonBottom: numberValue(config.buttonBottom, 3),
	buttonOffset: numberValue(config.buttonOffset, 3),
	buttonSize: numberValue(config.buttonSize, 60),
	...brandingPublicFields(config, hardPlan)
});

export const normalizePhone = (value: unknown): string | undefined => {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	const phone = value.trim();
	const digits = phone.replace(/\D/g, '');
	let normalized = phone;
	if (
		digits.length === 11 &&
		(digits.startsWith('7') || digits.startsWith('8'))
	) {
		normalized = `+7${digits.slice(1)}`;
	} else if (digits.length === 10) {
		normalized = `+7${digits}`;
	} else if (digits.length > 0 && phone.startsWith('+')) {
		normalized = `+${digits}`;
	}
	if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) {
		throw new BadRequestException('Укажите корректный телефон');
	}
	return normalized;
};

export const normalizeEmail = (value: unknown): string | undefined => {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	const email = value.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new BadRequestException('Укажите корректный email');
	}
	return email;
};

export const dataType = (
	config: Record<string, unknown>,
	fallback: 'PHONE' | 'NONE' = 'PHONE'
): 'PHONE' | 'EMAIL' | 'PHONE_AND_EMAIL' | 'NONE' => {
	const value = stringValue(config.dataType, fallback).toUpperCase();
	return ['PHONE', 'EMAIL', 'PHONE_AND_EMAIL', 'NONE'].includes(value)
		? (value as 'PHONE' | 'EMAIL' | 'PHONE_AND_EMAIL' | 'NONE')
		: fallback;
};

export const assertContact = (
	type: ReturnType<typeof dataType>,
	phone: string | undefined,
	email: string | undefined
): void => {
	if (type === 'NONE') {
		throw new BadRequestException('Сбор контактов отключён');
	}
	if (type === 'PHONE' && !phone) {
		throw new BadRequestException('Укажите телефон');
	}
	if (type === 'EMAIL' && !email) {
		throw new BadRequestException('Укажите email');
	}
	if (type === 'PHONE_AND_EMAIL' && (!phone || !email)) {
		throw new BadRequestException('Укажите телефон и email');
	}
};

export const cooldownSince = (days: unknown): Date | undefined => {
	const normalized = numberValue(days, 0);
	return normalized > 0
		? new Date(Date.now() - normalized * 24 * 60 * 60 * 1000)
		: undefined;
};

export const emptyStats = () => null;

export const unchangedLead = (lead: WidgetLeadRecord) => lead;

export const toInputJson = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export const formatCalculatorAnswers = (value: unknown): string => {
	if (!Array.isArray(value)) return '';
	return value
		.map(item => {
			const answer = asJsonObject(item);
			return answer.fieldLabel && answer.valueLabel
				? `${String(answer.fieldLabel)}: ${String(answer.valueLabel)}`
				: '';
		})
		.filter(Boolean)
		.join('; ');
};
