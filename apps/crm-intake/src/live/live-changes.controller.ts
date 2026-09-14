import {
	Controller,
	Get,
	Headers,
	Query,
	Res,
	ParseUUIDPipe,
	ForbiddenException,
	UnauthorizedException
} from '@nestjs/common';
import type { Response } from 'express';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import { LiveChangesService } from './live-changes.service';

@Controller('crm/intake')
export class LiveChangesController {
	constructor(
		private readonly access: IntakeAuthorizationClient,
		private readonly live: LiveChangesService
	) {}
	@Get('events')
	async events(
		@Headers('authorization') bearer: string | undefined,
		@Query('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Res() response: Response
	) {
		if (!bearer || !/^Bearer [^\s]{1,16384}$/.test(bearer))
			throw new UnauthorizedException();
		const authorize = async () => {
			const access = await this.access.authorize(bearer, workspaceId);
			if (!access.permissions.includes('intake:read'))
				throw new ForbiddenException();
			return access;
		};
		const initial = await authorize();
		return this.live.open(
			workspaceId,
			initial.subject,
			response,
			async () => {
				const current = await authorize();
				if (JSON.stringify(current) !== JSON.stringify(initial))
					throw new ForbiddenException();
			}
		);
	}
}
