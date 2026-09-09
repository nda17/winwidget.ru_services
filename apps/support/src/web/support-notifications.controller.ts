import {
	Body,
	CanActivate,
	Controller,
	ExecutionContext,
	ForbiddenException,
	Header,
	HttpCode,
	Injectable,
	Param,
	ParseUUIDPipe,
	Post,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Equals as EqualsValue, IsIn, IsUUID } from 'class-validator';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import {
	SupportNotificationsService,
	SUPPORT_NOTIFICATION_KINDS,
	SupportNotificationKind
} from './support-notifications.service';

@Injectable()
export class SupportNotificationDeliveryGuard implements CanActivate {
	constructor(private readonly config: ConfigService) {}
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const token =
			this.config
				.get<string>('SUPPORT_NOTIFICATION_DELIVERY_TOKEN')
				?.trim() || '';
		const actual = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		const remote = (request.socket.remoteAddress || '').replace(
			/^::ffff:/,
			''
		);
		if (
			token.length < 32 ||
			token.startsWith('change_me') ||
			request.header('x-winwidget-service') !== 'notification-delivery' ||
			!(remote === '::1' || /^127(?:\.\d{1,3}){3}$/.test(remote)) ||
			actual.length !== Buffer.byteLength(token) ||
			!timingSafeEqual(actual, Buffer.from(token))
		)
			throw new ForbiddenException('Invalid internal credentials');
		return true;
	}
}
class SupportDeliveryContextDto {
	@EqualsValue(1) schemaVersion!: 1;
	@IsUUID('4') eventId!: string;
	@IsIn(SUPPORT_NOTIFICATION_KINDS) kind!: SupportNotificationKind;
}
@Controller('internal/v1/notification-delivery/support-notifications')
@UseGuards(SupportNotificationDeliveryGuard)
@UsePipes(
	new ValidationPipe({
		transform: true,
		whitelist: true,
		forbidNonWhitelisted: true,
		forbidUnknownValues: true
	})
)
export class SupportNotificationsController {
	constructor(
		private readonly notifications: SupportNotificationsService
	) {}
	@Post(':id/delivery-context')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	context(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: SupportDeliveryContextDto
	) {
		return this.notifications.deliveryContext(id, dto.eventId, dto.kind);
	}
}
