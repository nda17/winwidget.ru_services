import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Post,
	Req,
	Res,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
	ArrayMaxSize,
	ArrayNotEmpty,
	Equals,
	IsArray,
	IsIn,
	IsString,
	MaxLength
} from 'class-validator';
import {
	DirectoryResolveDto,
	DirectorySearchDto,
	LifecycleCompleteDto
} from '../auth/auth.dto';
import { IdentityInternalGuard, InternalServices } from './internal.guard';
import { IdentityInternalService } from './internal.service';
import { IdentityProviderHealthService } from '../health/identity-provider-health.service';

export class CampaignContactsDto {
	@Equals(1)
	schemaVersion!: 1;

	@IsIn(['EMAIL', 'TELEGRAM'])
	channel!: 'EMAIL' | 'TELEGRAM';
}

export class AuditSnapshotsDto {
	@IsArray()
	@ArrayNotEmpty()
	@ArrayMaxSize(100)
	@IsString({ each: true })
	@MaxLength(255, { each: true })
	userIds!: string[];
}

@Controller('internal/v1')
@UseGuards(IdentityInternalGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class IdentityInternalController {
	constructor(
		private readonly internal: IdentityInternalService,
		private readonly providerHealth: IdentityProviderHealthService
	) {}

	@Post('auth/introspect')
	@HttpCode(200)
	@InternalServices(
		'core',
		'campaigns',
		'reporting',
		'widgets',
		'billing',
		'platform',
		'support'
	)
	introspect(@Headers('authorization') authorization?: string) {
		return this.internal.introspect(authorization);
	}

	@Post('widgets/owners/resolve')
	@HttpCode(200)
	@InternalServices('widgets')
	resolveOwners(@Body() dto: DirectoryResolveDto) {
		return this.internal.resolveOwners(dto);
	}

	@Post('widgets/owners/search')
	@HttpCode(200)
	@InternalServices('widgets')
	searchOwners(@Body() dto: DirectorySearchDto) {
		return this.internal.searchOwners(dto);
	}

	@Post('core/audit-snapshots')
	@HttpCode(200)
	@InternalServices('core')
	auditSnapshots(@Body() dto: AuditSnapshotsDto) {
		return this.internal.auditSnapshots(dto.userIds);
	}

	@Get('core/admin-health')
	@HttpCode(200)
	@InternalServices('core')
	adminHealth() {
		return this.providerHealth.providerHealth();
	}

	@Post('campaigns/eligible-contacts')
	@HttpCode(200)
	@InternalServices('campaigns')
	async campaignContacts(
		@Body() body: CampaignContactsDto,
		@Req() request: Request,
		@Res() response: Response
	): Promise<void> {
		if (
			!body ||
			body.schemaVersion !== 1 ||
			!['EMAIL', 'TELEGRAM'].includes(body.channel)
		) {
			throw new Error('Invalid campaign contact export request');
		}
		response.status(200);
		response.setHeader(
			'Content-Type',
			'application/x-ndjson; charset=utf-8'
		);
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Accel-Buffering', 'no');
		try {
			await this.internal.streamCampaignContacts(
				body.channel,
				request,
				response
			);
			response.end();
		} catch (error) {
			if (!response.headersSent) throw error;
			response.destroy(
				error instanceof Error
					? error
					: new Error('Campaign contact export failed')
			);
		}
	}

	@Post('billing/lifecycle/complete')
	@HttpCode(200)
	@InternalServices('billing')
	completeLifecycle(
		@Body() dto: LifecycleCompleteDto,
		@Req() request: Request
	) {
		return this.internal.completeLifecycle(dto, request);
	}
}
