import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { intakeOperationToken } from './intake-operation.client';

@Injectable()
export class IntakeOperationGuard implements CanActivate {
	canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<Request>();
		const peer = (request.socket.remoteAddress || '').replace(
			/^::ffff:/,
			''
		);
		const candidate = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		const expected = Buffer.from(
			intakeOperationToken('CRM_SALES_CRM_INTAKE_TOKEN')
		);
		if (
			request.header('x-winwidget-service') !== 'crm-intake' ||
			(peer !== '::1' && !/^127(?:\.\d{1,3}){3}$/.test(peer)) ||
			candidate.length !== expected.length ||
			!timingSafeEqual(candidate, expected)
		)
			throw new ForbiddenException('Invalid internal credentials');
		return true;
	}
}
