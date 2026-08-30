import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import {
	IdentityInternalGuard,
	InternalServices
} from '../internal/internal.guard';
import { IDENTITY_SCALAR_QUERY_PIPE } from '../common/identity.util';
import { IdentityMessagingAdminService } from './messaging-admin.service';

class RetryIdentityFailureDto {
	@IsString()
	@MinLength(1)
	@MaxLength(255)
	actorId!: string;
}

class CloseIdentityFailureDto extends RetryIdentityFailureDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1_000)
	comment!: string;
}

@Controller('internal/v1/identity/messaging')
@UseGuards(IdentityInternalGuard)
@InternalServices('operations')
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class IdentityMessagingAdminController {
	constructor(private readonly messaging: IdentityMessagingAdminService) {}

	@Get('overview')
	@HttpCode(200)
	overview() {
		return this.messaging.overview();
	}

	@Get('failures')
	@HttpCode(200)
	failures(
		@Query('page', IDENTITY_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', IDENTITY_SCALAR_QUERY_PIPE) limit?: string,
		@Query('consumer', IDENTITY_SCALAR_QUERY_PIPE) consumer?: string,
		@Query('category', IDENTITY_SCALAR_QUERY_PIPE) category?: string,
		@Query('status', IDENTITY_SCALAR_QUERY_PIPE) status?: string
	) {
		return this.messaging.failures(
			this.integer(page, 1),
			this.integer(limit, 20),
			{ consumer, category, status }
		);
	}

	@Post('failures/:id/retry')
	@HttpCode(200)
	retry(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() dto: RetryIdentityFailureDto,
		@Req() request: Request
	) {
		return this.messaging.retry(id, dto.actorId, request);
	}

	@Post('failures/:id/close')
	@HttpCode(200)
	close(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() dto: CloseIdentityFailureDto,
		@Req() request: Request
	) {
		return this.messaging.close(id, dto.actorId, dto.comment, request);
	}

	private integer(value: string | undefined, fallback: number): number {
		if (!value?.trim()) return fallback;
		if (!/^\d+$/.test(value.trim())) return fallback;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : fallback;
	}
}
