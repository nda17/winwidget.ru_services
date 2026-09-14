import {
	Controller,
	Get,
	Headers,
	Res,
	UseGuards,
	ForbiddenException
} from '@nestjs/common';
import type { Response } from 'express';
import { SupportAuth, SupportAuthGuard } from '../auth/support-auth.guard';
import { IdentityIntrospectionClient } from '../auth/identity-introspection.client';
import { CurrentSupportActor } from '../auth/current-support-actor.decorator';
import type { SupportActor } from '../auth/support-request';
import { LiveChangesService } from './live-changes.service';

@Controller('support')
@UseGuards(SupportAuthGuard)
@SupportAuth(['USER', 'ADMIN', 'DEV'])
export class LiveChangesController {
	constructor(
		private readonly identity: IdentityIntrospectionClient,
		private readonly live: LiveChangesService
	) {}
	@Get('events')
	events(
		@Headers('authorization') bearer: string,
		@CurrentSupportActor() actor: SupportActor,
		@Res() response: Response
	) {
		return this.live.open(
			actor.subject,
			actor.subject,
			response,
			async () => {
				const current = await this.identity.introspect(bearer);
				if (JSON.stringify(current) !== JSON.stringify(actor))
					throw new ForbiddenException();
			}
		);
	}
}
