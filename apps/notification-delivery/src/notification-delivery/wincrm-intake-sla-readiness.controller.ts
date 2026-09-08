import {
	CanActivate,
	Controller,
	ExecutionContext,
	ForbiddenException,
	Get,
	Header,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException,
	UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { isNotificationDeliveryLoopbackAddress } from './control/notification-delivery-internal-token.guard';
import { NotificationDeliveryHealthService } from './notification-delivery-health.service';
import {
	validSlaToken,
	WincrmIntakeSlaContextService
} from './wincrm-intake-sla-context.service';
import { NotificationDeliveryWorkerService } from './notification-delivery-worker.service';
import { WINCRM_INTAKE_SLA_KINDS } from '../messaging/messaging.constants';

@Injectable()
export class WincrmIntakeSlaReadinessGuard implements CanActivate {
	constructor(private readonly config: ConfigService) {}
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (
			!isNotificationDeliveryLoopbackAddress(
				request.socket?.remoteAddress
			) ||
			request.headers['x-winwidget-service'] !== 'crm-intake'
		)
			throw new ForbiddenException('Invalid Intake SLA readiness caller');
		const token = this.config.get<string>(
			'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN'
		);
		if (
			!validSlaToken(token) ||
			[
				'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN',
				'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
				'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
				'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN',
				'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
			].some(key => this.config.get<string>(key) === token)
		)
			throw new ServiceUnavailableException(
				'Intake SLA readiness is not configured'
			);
		const supplied = request.headers['x-winwidget-internal-token'];
		const hash = (value: string) =>
			createHash('sha256').update(value).digest();
		if (
			typeof supplied !== 'string' ||
			supplied.length > 4096 ||
			!timingSafeEqual(hash(supplied), hash(token))
		)
			throw new UnauthorizedException(
				'Invalid Intake SLA readiness token'
			);
		return true;
	}
}

@Controller('internal/v1/crm-intake/sla')
@UseGuards(WincrmIntakeSlaReadinessGuard)
export class WincrmIntakeSlaReadinessController {
	constructor(
		private readonly health: NotificationDeliveryHealthService,
		private readonly reminder: WincrmIntakeSlaContextService,
		private readonly worker: NotificationDeliveryWorkerService
	) {}
	@Get('readiness')
	@Header('Cache-Control', 'no-store')
	async readiness() {
		try {
			this.reminder.assertConfigured(true);
			await this.health.getReadinessHealth();
			this.reminder.assertConfigured(true);
			if (!this.worker.isReadyForKinds(WINCRM_INTAKE_SLA_KINDS))
				throw new Error('Reminder consumers not running');
		} catch {
			throw new ServiceUnavailableException(
				'Intake SLA delivery is not ready'
			);
		}
		return {
			schemaVersion: 1,
			ready: true,
			checkedAt: new Date().toISOString(),
			channels: ['EMAIL', 'TELEGRAM']
		};
	}
}
