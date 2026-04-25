import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateCallbackDto } from '@/callback/dto/create-callback.dto';
import { UpdateCallbackDto } from '@/callback/dto/update-callback.dto';
import { CallbackService } from '@/callback/callback.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Res,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Response } from 'express';

@Controller('callbacks')
export class CallbackController {
	constructor(private readonly callbackService: CallbackService) {}

	@HttpCode(200)
	@Auth()
	@Get()
	async getMyCallbacks(@CurrentUser('id') userId: string) {
		return this.callbackService.getMyCallbacks(userId);
	}

	@HttpCode(201)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post()
	async createCallback(
		@CurrentUser('id') userId: string,
		@Body() dto: CreateCallbackDto
	) {
		return this.callbackService.createCallback(userId, dto);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch(':id')
	async updateCallback(
		@CurrentUser('id') userId: string,
		@Param('id') callbackId: string,
		@Body() dto: UpdateCallbackDto
	) {
		return this.callbackService.updateCallback(userId, callbackId, dto);
	}

	@HttpCode(200)
	@Auth()
	@Delete(':id')
	async deleteCallback(
		@CurrentUser('id') userId: string,
		@Param('id') callbackId: string
	) {
		return this.callbackService.deleteCallback(userId, callbackId);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/export')
	async exportLeads(
		@CurrentUser('id') userId: string,
		@Param('id') callbackId: string,
		@Query('format') format: string,
		@Res() res: Response
	) {
		const fmt = format === 'xlsx' ? 'xlsx' : 'csv';
		const result = await this.callbackService.exportLeads(
			userId,
			callbackId,
			fmt
		);
		res.setHeader('Content-Type', result.contentType);
		res.setHeader(
			'Content-Disposition',
			`attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`
		);
		res.send(result.data);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads')
	async getLeads(
		@CurrentUser('id') userId: string,
		@Param('id') callbackId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.callbackService.getLeads(
			userId,
			callbackId,
			page ? parseInt(page) : 1,
			limit ? parseInt(limit) : 50
		);
	}
}
