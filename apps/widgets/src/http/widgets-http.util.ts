import {
	BadRequestException,
	createParamDecorator,
	ExecutionContext
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { WidgetsRequest } from '../auth/widgets-request';
import {
	parseWidgetType,
	WidgetType,
	WIDGET_DEFINITIONS
} from '../domain/widgets-domain.types';

export const CurrentWidgetsActor = createParamDecorator(
	(_data: unknown, context: ExecutionContext) =>
		context.switchToHttp().getRequest<WidgetsRequest>().widgetsActor
);

export const requestCorrelationId = (request: Request): string => {
	const raw = request.headers['x-correlation-id'];
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === 'string' &&
		/^[A-Za-z0-9._:-]{1,128}$/.test(value)
		? value
		: randomUUID();
};

export const typeFromRequestPath = (request: Request): WidgetType => {
	const segments = request.path.split('/').filter(Boolean);
	const match = WIDGET_DEFINITIONS.find(
		definition =>
			segments.includes(definition.collection) ||
			segments.includes(definition.publicApi) ||
			segments.includes(definition.pagePath)
	);
	if (!match) throw new BadRequestException('Некорректный тип виджета');
	return match.type;
};

export const parseLifecycleType = (value: string): WidgetType =>
	parseWidgetType(value);
