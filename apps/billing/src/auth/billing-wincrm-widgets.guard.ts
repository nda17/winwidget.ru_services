import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

const CALLERS = {
	widgets: 'BILLING_WINCRM_WIDGETS_TOKEN',
	'crm-intake': 'BILLING_WINCRM_CRM_INTAKE_TOKEN'
} as const;
const EXISTING_PAIRS = [
	'BILLING_IDENTITY_TOKEN',
	'BILLING_CRM_ACCESS_TOKEN',
	'BILLING_CAMPAIGNS_TOKEN',
	'BILLING_OPERATIONS_TOKEN',
	'IDENTITY_BILLING_TOKEN',
	'WIDGETS_INTERNAL_TOKEN'
] as const;

const loopback = (address?: string): boolean => {
	if (!address) return false;
	if (address === '::1') return true;
	const normalized = address.toLowerCase().replace(/^::ffff:/, '');
	const octets = normalized.split('.');
	return (
		octets.length === 4 &&
		octets[0] === '127' &&
		octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	);
};

@Injectable()
export class BillingWincrmWidgetsGuard implements CanActivate {
	private readonly enabled: boolean;
	private readonly tokens = new Map<string, Buffer>();

	constructor(config: ConfigService) {
		const flag = config.get<unknown>(
			'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED'
		);
		if (flag === undefined || flag === false || flag === 'false') {
			this.enabled = false;
			return;
		}
		if (flag !== true && flag !== 'true') {
			throw new Error(
				'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED must be true or false'
			);
		}
		this.enabled = true;
		const used = new Set(
			EXISTING_PAIRS.map(key => config.get<string>(key)?.trim()).filter(
				Boolean
			)
		);
		for (const [caller, key] of Object.entries(CALLERS)) {
			const token = config.get<string>(key) || '';
			if (
				!/^[\x21-\x7e]{32,512}$/.test(token) ||
				/change[_-]?me|^ci_|^XYZXYZXYZ$|^billing_.*_token$|[<>]/i.test(
					token
				)
			) {
				throw new Error(
					`${key} requires a non-placeholder secret of 32-512 printable characters`
				);
			}
			if (used.has(token)) {
				throw new Error(
					`${key} must be distinct from other service credentials`
				);
			}
			used.add(token);
			this.tokens.set(caller, Buffer.from(token));
		}
	}

	canActivate(context: ExecutionContext): boolean {
		if (!this.enabled) throw new NotFoundException();
		const request = context.switchToHttp().getRequest<Request>();
		const token = this.tokens.get(
			request.header('x-winwidget-service') || ''
		);
		if (!token || !loopback(request.socket?.remoteAddress)) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		const candidate = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			candidate.length !== token.length ||
			!timingSafeEqual(candidate, token)
		) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		return true;
	}
}
