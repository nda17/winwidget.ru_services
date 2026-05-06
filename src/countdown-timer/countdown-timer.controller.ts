import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateCountdownTimerDto } from '@/countdown-timer/dto/create-countdown-timer.dto';
import { UpdateCountdownTimerDto } from '@/countdown-timer/dto/update-countdown-timer.dto';
import { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
import { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES } from '@/file/file.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Res,
	UploadedFile,
	UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';

@Auth()
@Controller('countdown-timers')
export class CountdownTimerController {
	constructor(
		private readonly countdownTimerService: CountdownTimerService
	) {}

	@Get()
	async getMyCountdownTimers(@CurrentUser('id') userId: string) {
		return this.countdownTimerService.getMyCountdownTimers(userId);
	}

	@Post()
	async createCountdownTimer(
		@CurrentUser('id') userId: string,
		@Body() dto: CreateCountdownTimerDto
	) {
		return this.countdownTimerService.createCountdownTimer(userId, dto);
	}

	@Patch(':id')
	async updateCountdownTimer(
		@CurrentUser('id') userId: string,
		@Param('id') countdownTimerId: string,
		@Body() dto: UpdateCountdownTimerDto
	) {
		return this.countdownTimerService.updateCountdownTimer(
			userId,
			countdownTimerId,
			dto
		);
	}

	@Post(':id/button-image')
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES }
		})
	)
	async uploadButtonImage(
		@CurrentUser('id') userId: string,
		@Param('id') countdownTimerId: string,
		@UploadedFile() file?: Express.Multer.File
	) {
		return this.countdownTimerService.uploadButtonImage(
			userId,
			countdownTimerId,
			file
		);
	}

	@Delete(':id')
	async deleteCountdownTimer(
		@CurrentUser('id') userId: string,
		@Param('id') countdownTimerId: string
	) {
		return this.countdownTimerService.deleteCountdownTimer(
			userId,
			countdownTimerId
		);
	}

	@Get(':id/leads')
	async getLeads(
		@CurrentUser('id') userId: string,
		@Param('id') countdownTimerId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.countdownTimerService.getLeads(
			userId,
			countdownTimerId,
			Number(page) || 1,
			Number(limit) || 50
		);
	}

	@Get(':id/leads/export')
	async exportLeads(
		@CurrentUser('id') userId: string,
		@Param('id') countdownTimerId: string,
		@Query('format') format: 'csv' | 'xlsx' = 'csv',
		@Res() res: Response
	) {
		const result = await this.countdownTimerService.exportLeads(
			userId,
			countdownTimerId,
			format === 'xlsx' ? 'xlsx' : 'csv'
		);
		res.setHeader('Content-Type', result.contentType);
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${encodeURIComponent(result.filename)}"`
		);
		return res.send(result.data);
	}
}
