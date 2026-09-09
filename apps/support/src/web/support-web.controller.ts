import {
	BadRequestException,
	CallHandler,
	ExecutionContext,
	Injectable,
	mixin,
	NestInterceptor,
	Type,
	Body,
	Controller,
	Delete,
	Get,
	Header,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Put,
	Query,
	Req,
	Res,
	UploadedFile,
	UseGuards,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { CurrentSupportActor } from '../auth/current-support-actor.decorator';
import { SupportAuth, SupportAuthGuard } from '../auth/support-auth.guard';
import type { SupportActor } from '../auth/support-request';
import { SupportAttachmentsService } from './support-attachments.service';
import { SUPPORT_UPLOAD_LIMITS } from './support-attachment-storage.service';
import { SupportConversationsService } from './support-conversations.service';
import {
	CreateSupportConversationDto,
	SupportAdminListDto,
	SupportHistoryDto,
	SupportListDto,
	SupportMessageDto,
	SupportNotificationSettingsDto,
	SupportReadDto,
	SupportStatusDto,
	SupportUploadDto
} from './support-web.dto';
import { SupportWebRateGuard } from './support-web-rate.guard';

const UUID_PIPE = new ParseUUIDPipe({ version: '4' });
const validation = new ValidationPipe({
	transform: true,
	whitelist: true,
	forbidNonWhitelisted: true,
	forbidUnknownValues: true
});

function supportUploadInterceptor(): Type<NestInterceptor> {
	const Base = FileInterceptor('file', { limits: SUPPORT_UPLOAD_LIMITS });
	@Injectable()
	class SupportUploadInterceptor extends Base {
		override async intercept(
			context: ExecutionContext,
			next: CallHandler
		): Promise<Observable<unknown>> {
			try {
				return await super.intercept(context, next);
			} catch (error) {
				if (
					error instanceof Error &&
					'code' in error &&
					error.code === 'LIMIT_FIELD_NESTING'
				)
					throw new BadRequestException('Некорректные поля загрузки');
				throw error;
			}
		}
	}
	return mixin(SupportUploadInterceptor);
}

@Controller('support')
@UseGuards(SupportAuthGuard, SupportWebRateGuard)
@SupportAuth(['USER', 'ADMIN', 'DEV'])
@UsePipes(validation)
export class SupportWebController {
	constructor(
		private readonly conversations: SupportConversationsService,
		private readonly attachments: SupportAttachmentsService
	) {}
	@Get('conversations')
	@Header('Cache-Control', 'no-store')
	list(
		@Query() dto: SupportListDto,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.list(dto, actor);
	}
	@Post('conversations')
	@Header('Cache-Control', 'no-store')
	create(
		@Body() dto: CreateSupportConversationDto,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.conversations.create(dto, actor, request);
	}
	@Get('conversations/:id')
	@Header('Cache-Control', 'no-store')
	detail(
		@Param('id', UUID_PIPE) id: string,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.detail(id, actor);
	}
	@Get('conversations/:id/messages')
	@Header('Cache-Control', 'no-store')
	history(
		@Param('id', UUID_PIPE) id: string,
		@Query() dto: SupportHistoryDto,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.history(id, dto, actor);
	}
	@Post('conversations/:id/messages')
	@Header('Cache-Control', 'no-store')
	reply(
		@Param('id', UUID_PIPE) id: string,
		@Body() dto: SupportMessageDto,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.conversations.reply(id, dto, actor, request);
	}
	@Put('conversations/:id/read')
	@Header('Cache-Control', 'no-store')
	read(
		@Param('id', UUID_PIPE) id: string,
		@Body() dto: SupportReadDto,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.read(id, dto.throughSequence, actor);
	}
	@Get('unread-count')
	@Header('Cache-Control', 'no-store')
	count(@CurrentSupportActor() actor: SupportActor) {
		return this.conversations.unreadCount(actor);
	}
	@Get('commands/:commandId')
	@Header('Cache-Control', 'no-store')
	command(
		@Param('commandId', UUID_PIPE) commandId: string,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.recover(commandId, actor);
	}
	@Post('attachments')
	@Header('Cache-Control', 'no-store')
	@UseInterceptors(supportUploadInterceptor())
	upload(
		@Body() dto: SupportUploadDto,
		@UploadedFile() file: Express.Multer.File,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.attachments.upload(dto, file, actor);
	}
	@Delete('attachments/:id')
	@Header('Cache-Control', 'no-store')
	remove(
		@Param('id', UUID_PIPE) id: string,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.attachments.remove(id, actor);
	}
	@Get('attachments/:id/content')
	content(
		@Param('id', UUID_PIPE) id: string,
		@CurrentSupportActor() actor: SupportActor,
		@Res() response: Response
	) {
		return this.attachments.content(id, actor, response);
	}
}

@Controller('support/admin')
@UseGuards(SupportAuthGuard, SupportWebRateGuard)
@SupportAuth(['ADMIN', 'DEV'])
@UsePipes(validation)
export class SupportWebAdminController {
	constructor(
		private readonly conversations: SupportConversationsService
	) {}
	@Get('conversations')
	@Header('Cache-Control', 'no-store')
	list(
		@Query() dto: SupportAdminListDto,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.list(dto, actor, true);
	}
	@Get('conversations/:id')
	@Header('Cache-Control', 'no-store')
	detail(
		@Param('id', UUID_PIPE) id: string,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.detail(id, actor, true);
	}
	@Get('conversations/:id/messages')
	@Header('Cache-Control', 'no-store')
	history(
		@Param('id', UUID_PIPE) id: string,
		@Query() dto: SupportHistoryDto,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.history(id, dto, actor, true);
	}
	@Post('conversations/:id/messages')
	@Header('Cache-Control', 'no-store')
	reply(
		@Param('id', UUID_PIPE) id: string,
		@Body() dto: SupportMessageDto,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.conversations.reply(id, dto, actor, request, true);
	}
	@Put('conversations/:id/read')
	@Header('Cache-Control', 'no-store')
	read(
		@Param('id', UUID_PIPE) id: string,
		@Body() dto: SupportReadDto,
		@CurrentSupportActor() actor: SupportActor
	) {
		return this.conversations.read(id, dto.throughSequence, actor, true);
	}
	@Patch('conversations/:id/status')
	@Header('Cache-Control', 'no-store')
	status(
		@Param('id', UUID_PIPE) id: string,
		@Body() dto: SupportStatusDto,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.conversations.status(id, dto, actor, request);
	}
	@Get('unread-count')
	@Header('Cache-Control', 'no-store')
	count(@CurrentSupportActor() actor: SupportActor) {
		return this.conversations.unreadCount(actor, true);
	}
	@Get('notification-settings')
	@Header('Cache-Control', 'no-store')
	settings() {
		return this.conversations.settings();
	}
	@Patch('notification-settings')
	@SupportAuth(['DEV'])
	@Header('Cache-Control', 'no-store')
	updateSettings(
		@Body() dto: SupportNotificationSettingsDto,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.conversations.updateSettings(dto, actor, request);
	}
}
