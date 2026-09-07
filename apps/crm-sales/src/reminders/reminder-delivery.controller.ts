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
	UseGuards
} from '@nestjs/common';
import { Equals, IsIn, IsUUID } from 'class-validator';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { ReminderDeliveryService } from './reminder-delivery.service';
import { reminderInternalToken } from './reminder-readiness.service';

export class ReminderDeliveryContextDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') eventId!: string;
	@IsUUID('4') workspaceId!: string;
	@IsIn(['EMAIL', 'TELEGRAM']) channel!: 'EMAIL' | 'TELEGRAM';
}
@Injectable()
export class ReminderDeliveryGuard implements CanActivate {
	canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<Request>();
		const ip = request.socket.remoteAddress?.replace(/^::ffff:/, '');
		try {
			if (
				!(
					ip === '::1' ||
					(ip && isIP(ip) === 4 && ip.startsWith('127.'))
				) ||
				request.header('x-winwidget-service') !== 'notification-delivery'
			)
				throw new Error();
			const expected = Buffer.from(
				reminderInternalToken('CRM_SALES_NOTIFICATION_DELIVERY_TOKEN')
			);
			const supplied = Buffer.from(
				request.header('x-winwidget-internal-token') ?? ''
			);
			if (
				supplied.length !== expected.length ||
				!timingSafeEqual(supplied, expected)
			)
				throw new Error();
			return true;
		} catch {
			throw new ForbiddenException(
				'Invalid reminder delivery credentials'
			);
		}
	}
}
@Controller('internal/v1/notification-delivery/task-reminders')
@UseGuards(ReminderDeliveryGuard)
export class ReminderDeliveryController {
	constructor(private readonly service: ReminderDeliveryService) {}
	@Post(':id/delivery-context')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	context(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: ReminderDeliveryContextDto
	) {
		return this.service.context(id, dto);
	}
}
