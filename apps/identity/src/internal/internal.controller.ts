import {
	Body,
	BadRequestException,
	Controller,
	Get,
	Headers,
	Header,
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
	IsUUID,
	Matches,
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

export class CrmSourceContextDto {
	@Equals(1)
	schemaVersion!: 1;

	@IsUUID('4')
	workspaceId!: string;

	@IsString()
	@MaxLength(256)
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	subject!: string;
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
		'campaigns',
		'reporting',
		'widgets',
		'billing',
		'platform',
		'support',
		'operations'
	)
	introspect(@Headers('authorization') authorization?: string) {
		return this.internal.introspect(authorization);
	}

	@Post('crm-access/auth-context')
	@HttpCode(200)
	@InternalServices('crm-access')
	crmAccessAuthContext(@Headers('authorization') authorization?: string) {
		return this.internal.crmAccessAuthContext(authorization);
	}

	@Post('crm-access/source-context')
	@HttpCode(200)
	@InternalServices('crm-access')
	crmSourceContext(@Body() dto: CrmSourceContextDto) {
		return this.internal.crmSourceContext(dto.workspaceId, dto.subject);
	}

	@Post('crm-access/widget-source-context')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@InternalServices('crm-access')
	crmWidgetSourceContext(
		@Body() dto: CrmSourceContextDto,
		@Req() request: Request
	) {
		// The existing global whitelist strips extra DTO fields before local pipes.
		// Check this new exact contract against the original body, without changing old routes.
		const raw: unknown = request.body;
		if (
			!raw ||
			typeof raw !== 'object' ||
			Array.isArray(raw) ||
			Object.keys(raw).length !== 3 ||
			!['schemaVersion', 'workspaceId', 'subject'].every(key =>
				Object.hasOwn(raw, key)
			)
		)
			throw new BadRequestException('Invalid widget source context');
		return this.internal.crmWidgetSourceContext(
			dto.workspaceId,
			dto.subject
		);
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

	@Post('operations/audit-snapshots')
	@HttpCode(200)
	@InternalServices('operations')
	auditSnapshots(@Body() dto: AuditSnapshotsDto) {
		return this.internal.auditSnapshots(dto.userIds);
	}

	@Get('operations/admin-health')
	@HttpCode(200)
	@InternalServices('operations')
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
