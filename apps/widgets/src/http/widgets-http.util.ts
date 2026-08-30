import {
	BadRequestException,
	CallHandler,
	createParamDecorator,
	ExecutionContext,
	Injectable,
	mixin,
	NestInterceptor,
	type PipeTransform,
	Type
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import type { WidgetsRequest } from '../auth/widgets-request';
import {
	parseWidgetType,
	WidgetType,
	WIDGET_DEFINITIONS
} from '../domain/widgets-domain.types';
import { WIDGET_BUTTON_IMAGE_UPLOAD_LIMITS } from '../domain/widgets-image.service';

const MULTER_FIELD_NESTING_ERROR_CODE = 'LIMIT_FIELD_NESTING';

export const WIDGETS_SCALAR_QUERY_PIPE: PipeTransform<
	unknown,
	string | undefined
> = {
	transform(value: unknown): string | undefined {
		if (value === undefined) return undefined;
		if (typeof value !== 'string') {
			throw new BadRequestException(
				'Query parameter must contain exactly one string value'
			);
		}
		return value;
	}
};

export const transformWidgetUploadException = (
	error: unknown
): unknown => {
	if (
		error instanceof Error &&
		'code' in error &&
		error.code === MULTER_FIELD_NESTING_ERROR_CODE
	) {
		return new BadRequestException(error.message);
	}
	return error;
};

export const WidgetButtonImageInterceptor = (): Type<NestInterceptor> => {
	const BaseInterceptor = FileInterceptor('file', {
		limits: WIDGET_BUTTON_IMAGE_UPLOAD_LIMITS
	});

	@Injectable()
	class WidgetButtonImageUploadInterceptor extends BaseInterceptor {
		override async intercept(
			context: ExecutionContext,
			next: CallHandler
		): Promise<Observable<unknown>> {
			try {
				return await super.intercept(context, next);
			} catch (error) {
				throw transformWidgetUploadException(error);
			}
		}
	}

	return mixin(WidgetButtonImageUploadInterceptor);
};

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
