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
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { slaInternalToken } from './sla-recipients.client';
import { SlaDeliveryService } from './sla-delivery.service';

@Injectable()
export class SlaDeliveryGuard implements CanActivate {
	canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<Request>();
		const token = request.headers['x-winwidget-internal-token'];
		const expected = slaInternalToken(
			'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN'
		);
		if (
			!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
				request.socket.remoteAddress ?? ''
			) ||
			request.headers['x-winwidget-service'] !== 'notification-delivery' ||
			typeof token !== 'string' ||
			token.length > 4096 ||
			!timingSafeEqual(
				createHash('sha256').update(token).digest(),
				createHash('sha256').update(expected).digest()
			)
		)
			throw new ForbiddenException('Intake SLA caller is not allowed');
		return true;
	}
}
@Controller('internal/v1/notification-delivery/intake-sla')
@UseGuards(SlaDeliveryGuard)
export class SlaDeliveryController {
	constructor(private readonly service: SlaDeliveryService) {}
	@Post(':id/delivery-context')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	read(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() body: unknown
	) {
		return this.service.context(id, body);
	}
}
