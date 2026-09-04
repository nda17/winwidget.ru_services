import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { parseInternalToken } from '../internal/internal-http.config';
import type { CrmCaller } from './crm-authorization.service';

export const CRM_CALLERS = {
	'crm-customers': 'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
	'crm-sales': 'CRM_ACCESS_CRM_SALES_TOKEN',
	'crm-intake': 'CRM_ACCESS_CRM_INTAKE_TOKEN'
} as const;

@Injectable()
export class CrmInternalGuard implements CanActivate {
	private readonly tokens: Map<string, Buffer>;
	constructor(config: ConfigService) {
		this.tokens = new Map(
			Object.entries(CRM_CALLERS).map(([caller, name]) => [
				caller,
				Buffer.from(
					parseInternalToken(name, config.get<string>(name), [
						name.toLowerCase()
					])
				)
			])
		);
	}
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const address = request.socket.remoteAddress?.replace(/^::ffff:/, '');
		const loopback =
			address === '::1' ||
			Boolean(
				address && isIP(address) === 4 && address.startsWith('127.')
			);
		const caller = request.header('x-winwidget-service') as CrmCaller;
		const expected = this.tokens.get(caller);
		const supplied = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			!loopback ||
			!expected ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		return true;
	}
}
