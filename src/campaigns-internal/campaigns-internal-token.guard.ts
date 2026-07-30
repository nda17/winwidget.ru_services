import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
	CAMPAIGNS_INTERNAL_TOKEN_ENV,
	CAMPAIGNS_INTERNAL_TOKEN_HEADER,
	CAMPAIGNS_INTERNAL_TOKEN_MIN_LENGTH
} from './campaigns-internal.constants';

const IPV4_LOOPBACK_PATTERN =
	/^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;

const isLoopbackIpv4 = (address: string): boolean => {
	if (!IPV4_LOOPBACK_PATTERN.test(address)) return false;
	return address
		.split('.')
		.slice(1)
		.every(part => Number(part) >= 0 && Number(part) <= 255);
};

export const isCampaignsLoopbackAddress = (
	address: string | undefined
): boolean => {
	if (!address) return false;
	const normalized = address.toLowerCase();
	if (normalized === '::1') return true;
	if (isLoopbackIpv4(normalized)) return true;
	if (!normalized.startsWith('::ffff:')) return false;
	return isLoopbackIpv4(normalized.slice('::ffff:'.length));
};

const hashToken = (value: string): Buffer =>
	createHash('sha256').update(value, 'utf8').digest();

@Injectable()
export class CampaignsInternalTokenGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (!isCampaignsLoopbackAddress(request.socket?.remoteAddress)) {
			throw new ForbiddenException(
				'Campaigns internal API is loopback-only'
			);
		}

		const expectedToken =
			process.env[CAMPAIGNS_INTERNAL_TOKEN_ENV]?.trim();
		if (
			!expectedToken ||
			expectedToken === 'XYZXYZXYZ' ||
			expectedToken.length < CAMPAIGNS_INTERNAL_TOKEN_MIN_LENGTH
		) {
			throw new ServiceUnavailableException(
				'Campaigns internal token is not configured securely'
			);
		}

		const suppliedHeader =
			request.headers[CAMPAIGNS_INTERNAL_TOKEN_HEADER];
		if (
			typeof suppliedHeader !== 'string' ||
			!suppliedHeader ||
			suppliedHeader.length > 4096 ||
			!timingSafeEqual(hashToken(expectedToken), hashToken(suppliedHeader))
		) {
			throw new UnauthorizedException('Invalid campaigns internal token');
		}

		return true;
	}
}
