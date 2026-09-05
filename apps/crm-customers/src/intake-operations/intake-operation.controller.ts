import {
	BadRequestException,
	Body,
	CanActivate,
	Controller,
	ExecutionContext,
	ForbiddenException,
	Headers,
	HttpCode,
	Injectable,
	Post,
	ServiceUnavailableException,
	UseGuards
} from '@nestjs/common';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import {
	CloseContactOperationDto,
	ExecuteContactOperationDto,
	IntakeOperationBinding
} from './intake-operation.dto';
import { ContactIntakeOperationService } from './intake-operation.service';

@Injectable()
export class ContactIntakeOperationGuard implements CanActivate {
	canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<Request>();
		const peer = (request.socket.remoteAddress || '').replace(
			/^::ffff:/,
			''
		);
		const caller = request.header('x-winwidget-service');
		const action = context.getHandler().name;
		if (
			!isIP(peer) ||
			!(peer === '::1' || peer.startsWith('127.')) ||
			(caller !== 'crm-intake' &&
				!(
					caller === 'crm-sales' && ['read', 'verify'].includes(action)
				)) ||
			(action === 'verify' && caller !== 'crm-sales')
		)
			throw new ForbiddenException('Internal caller is not allowed');
		const name =
			caller === 'crm-intake'
				? 'CRM_CUSTOMERS_CRM_INTAKE_TOKEN'
				: 'CRM_CUSTOMERS_CRM_SALES_TOKEN';
		const token = process.env[name] || '';
		if (
			token.length < 32 ||
			token.length > 4096 ||
			/\s|change[_-]?me|replace-|<[^>]+>/i.test(token)
		)
			throw new ServiceUnavailableException(
				'Internal credential is not configured'
			);
		const candidate = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		const expected = Buffer.from(token);
		if (
			candidate.length !== expected.length ||
			!timingSafeEqual(candidate, expected)
		)
			throw new ForbiddenException('Internal credential is invalid');
		return true;
	}
}

@Controller('internal/v1/crm-customers/intake-operations')
@UseGuards(ContactIntakeOperationGuard)
export class ContactIntakeOperationController {
	constructor(
		private readonly operations: ContactIntakeOperationService
	) {}
	@Post('read') @HttpCode(200) read(@Body() dto: IntakeOperationBinding) {
		return this.operations.read(dto);
	}
	@Post('verify') @HttpCode(200) verify(
		@Body() dto: IntakeOperationBinding
	) {
		return this.operations.verify(dto);
	}
	@Post('execute') @HttpCode(200) execute(
		@Body() dto: ExecuteContactOperationDto,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.operations.execute(dto);
	}
	@Post('close') @HttpCode(200) close(
		@Body() dto: CloseContactOperationDto,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.operations.close(dto);
	}
	private key(commandId: string, key?: string) {
		if (key !== commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
