import {
	Body,
	CanActivate,
	Controller,
	ExecutionContext,
	ForbiddenException,
	Header,
	HttpCode,
	Injectable,
	Post,
	UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import {
	hasExactKeys,
	isRecord,
	isUuidV4,
	parseInternalToken
} from '../internal/internal-http.config';
import {
	billingEnabled,
	requireBilling,
	validHash,
	validInt,
	validSeats,
	validSubject,
	invalid
} from './billing.validation';
import { CrmBillingCapacityService } from './billing-capacity.service';

@Injectable()
export class BillingOperationGuard implements CanActivate {
	private readonly enabled: boolean;
	private readonly token: Buffer;
	constructor(config: ConfigService) {
		this.enabled = billingEnabled(config);
		this.token = Buffer.from(
			this.enabled
				? parseInternalToken(
						'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
						config.get<string>('BILLING_CRM_ACCESS_COMMERCE_TOKEN'),
						['billing_crm_access_commerce_token']
					)
				: ''
		);
	}
	canActivate(context: ExecutionContext) {
		requireBilling(this.enabled);
		const request = context.switchToHttp().getRequest<Request>();
		const address = request.socket.remoteAddress?.replace(/^::ffff:/, '');
		const loopback =
			address === '::1' ||
			Boolean(
				address && isIP(address) === 4 && address.startsWith('127.')
			);
		const supplied = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			!loopback ||
			request.header('x-winwidget-service') !== 'billing' ||
			supplied.length !== this.token.length ||
			!timingSafeEqual(supplied, this.token)
		)
			throw new ForbiddenException({
				message: 'Service authorization failed',
				code: 'SERVICE_AUTHORIZATION_FAILED'
			});
		return true;
	}
}
@Controller('internal/v1/crm-access/billing')
@UseGuards(BillingOperationGuard)
export class BillingOperationController {
	constructor(private readonly capacity: CrmBillingCapacityService) {}
	@Post('authorize-operation')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	authorize(@Body() body: unknown) {
		if (
			!isRecord(body) ||
			!hasExactKeys(body, [
				'schemaVersion',
				'workspaceId',
				'actorSubject',
				'commandId',
				'requestHash',
				'fenceRevision',
				'targetSeats'
			]) ||
			body.schemaVersion !== 1 ||
			!isUuidV4(body.workspaceId) ||
			!isUuidV4(body.commandId) ||
			!validSubject(body.actorSubject) ||
			!validHash(body.requestHash) ||
			!validInt(body.fenceRevision) ||
			!validSeats(body.targetSeats)
		)
			invalid();
		return this.capacity.authorizeOperation(
			body as unknown as Parameters<
				CrmBillingCapacityService['authorizeOperation']
			>[0]
		);
	}
}
