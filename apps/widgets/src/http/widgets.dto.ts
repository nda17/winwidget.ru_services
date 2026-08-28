import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsDefined,
	IsEmail,
	IsIn,
	IsInt,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	MinLength,
	Min,
	ValidateIf,
	ValidateNested
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateWidgetDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}

export class UpdateWidgetDto {
	@IsOptional()
	@IsInt()
	@Min(0)
	expectedDraftRevision?: number;

	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;

	@IsOptional()
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsString()
	@MaxLength(253)
	installDomain?: string;

	@IsOptional()
	@IsObject()
	config?: Record<string, unknown>;
}

export class ExpectedDraftRevisionDto {
	@IsInt()
	@Min(0)
	expectedDraftRevision: number;
}

export class CloneWidgetDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}

export class CalculatorAnswerDto {
	@IsString()
	@MaxLength(64)
	fieldId: string;

	@IsDefined()
	value: unknown;
}

export class SubmitWidgetLeadDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	key?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	contact?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	name?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	phone?: string;

	@IsOptional()
	@IsEmail({}, { message: 'Укажите корректный email' })
	@MaxLength(200)
	email?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	bonus?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	result?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timeSlot?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timezone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(120)
	actionLabel?: string;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	actionValue?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;

	@IsOptional()
	@IsArray()
	@ArrayMaxSize(20)
	answers?: unknown[];
}

export class CallbackVerificationStartDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	phone?: string;

	@IsOptional()
	@IsEmail({}, { message: 'Укажите корректный email' })
	@MaxLength(200)
	email?: string;
}

export class SubmitCallbackLeadDto {
	@IsString()
	@MaxLength(200)
	phone: string;

	@IsOptional()
	@IsEmail({}, { message: 'Укажите корректный email' })
	@MaxLength(200)
	email?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timeSlot?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timezone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;

	@IsOptional()
	@IsUUID('4')
	challengeId?: string;

	@IsOptional()
	@IsString()
	@Matches(/^\d{6}$/, { message: 'Код должен содержать 6 цифр' })
	code?: string;
}

export class AiConsultantHistoryMessageDto {
	@IsIn(['user', 'assistant'])
	role: 'user' | 'assistant';

	@IsString()
	@MinLength(1)
	@MaxLength(2000)
	@Matches(/\S/, { message: 'Сообщение истории не должно быть пустым' })
	content: string;
}

export class AiConsultantMessageDto {
	@IsUUID('4')
	requestId: string;

	@IsString()
	@Matches(/^[A-Za-z0-9_-]{16,128}$/)
	sessionId: string;

	@IsString()
	@MinLength(1)
	@MaxLength(1000)
	@Matches(/\S/, { message: 'Вопрос не должен быть пустым' })
	message: string;

	@IsOptional()
	@IsArray()
	@ArrayMaxSize(12)
	@ValidateNested({ each: true })
	@Type(() => AiConsultantHistoryMessageDto)
	history?: AiConsultantHistoryMessageDto[];
}

export class AiConsultantPublicMessageDto extends AiConsultantMessageDto {
	@IsString()
	@MinLength(80)
	@MaxLength(2048)
	@Matches(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
	sessionToken: string;
}

export class AiConsultantSessionDto {
	@IsString()
	@Matches(/^[A-Za-z0-9_-]{16,128}$/)
	sessionId: string;

	@IsString()
	@MinLength(1)
	@MaxLength(2048)
	@Matches(/^[^\s\u0000-\u001f\u007f]+$/)
	turnstileToken: string;
}

export const WIDGET_RUNTIME_EVENTS = [
	'IMPRESSION',
	'OPEN',
	'START',
	'COMPLETE',
	'STEP'
] as const;
export type WidgetRuntimeEvent = (typeof WIDGET_RUNTIME_EVENTS)[number];

export class RecordWidgetRuntimeEventDto {
	@IsIn(WIDGET_RUNTIME_EVENTS)
	event: WidgetRuntimeEvent;

	@IsString()
	@MaxLength(32)
	runtimeVersion: string;

	@IsInt()
	@Min(1)
	publishedVersion: number;

	@ValidateIf(
		(value: RecordWidgetRuntimeEventDto) => value.event === 'STEP'
	)
	@IsDefined()
	@IsString()
	@MaxLength(32)
	@Matches(/^(?:question|field):(?:[1-9]|1[0-9]|20)$/)
	stepKey?: string;
}

export class AdminOwnerOverviewDto {
	@IsString()
	@MaxLength(255)
	userId: string;
}

export class RetryDeliveryDto {
	@IsString()
	@MaxLength(255)
	widgetId: string;

	@IsString()
	@MaxLength(64)
	widgetType: string;
}

export class CloseDeliveryFailureDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	comment: string;
}
