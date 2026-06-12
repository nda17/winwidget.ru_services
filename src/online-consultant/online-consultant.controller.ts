import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateOnlineConsultantDto } from '@/online-consultant/dto/create-online-consultant.dto';
import { UpdateOnlineConsultantDto } from '@/online-consultant/dto/update-online-consultant.dto';
import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES } from '@/file/file.service';
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
	UploadedFile,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';

@Controller('online-consultants')
export class OnlineConsultantController {
	constructor(
		private readonly onlineConsultantService: OnlineConsultantService
	) {}

	@HttpCode(200)
	@Auth()
	@Get()
	async getMyOnlineConsultants(@CurrentUser('id') userId: string) {
		return this.onlineConsultantService.getMyOnlineConsultants(userId);
	}

	@HttpCode(201)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post()
	async createOnlineConsultant(
		@CurrentUser('id') userId: string,
		@Body() dto: CreateOnlineConsultantDto
	) {
		return this.onlineConsultantService.createOnlineConsultant(
			userId,
			dto
		);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch(':id')
	async updateOnlineConsultant(
		@CurrentUser('id') userId: string,
		@Param('id') onlineConsultantId: string,
		@Body() dto: UpdateOnlineConsultantDto
	) {
		return this.onlineConsultantService.updateOnlineConsultant(
			userId,
			onlineConsultantId,
			dto
		);
	}

	@HttpCode(200)
	@Auth()
	@Post(':id/button-image')
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES }
		})
	)
	async uploadButtonImage(
		@CurrentUser('id') userId: string,
		@Param('id') onlineConsultantId: string,
		@UploadedFile() file?: Express.Multer.File
	) {
		return this.onlineConsultantService.uploadButtonImage(
			userId,
			onlineConsultantId,
			file
		);
	}

	@HttpCode(200)
	@Auth()
	@Delete(':id')
	async deleteOnlineConsultant(
		@CurrentUser('id') userId: string,
		@Param('id') onlineConsultantId: string
	) {
		return this.onlineConsultantService.deleteOnlineConsultant(
			userId,
			onlineConsultantId
		);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/export')
	async exportLeads(
		@CurrentUser('id') userId: string,
		@Param('id') onlineConsultantId: string,
		@Query('format') format: string,
		@Res() res: Response
	) {
		const fmt = format === 'xlsx' ? 'xlsx' : 'csv';
		const result = await this.onlineConsultantService.exportLeads(
			userId,
			onlineConsultantId,
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
		@Param('id') onlineConsultantId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.onlineConsultantService.getLeads(
			userId,
			onlineConsultantId,
			page ? parseInt(page) : 1,
			limit ? parseInt(limit) : 50
		);
	}
}
