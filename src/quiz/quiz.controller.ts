import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreateQuizDto } from '@/quiz/dto/create-quiz.dto';
import { UpdateQuizDto } from '@/quiz/dto/update-quiz.dto';
import { QuizService } from '@/quiz/quiz.service';
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

@Controller('quizzes')
export class QuizController {
	constructor(private readonly quizService: QuizService) {}

	@HttpCode(200)
	@Auth()
	@Get()
	async getMyQuizzes(@CurrentUser('id') userId: string) {
		return this.quizService.getMyQuizzes(userId);
	}

	@HttpCode(201)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post()
	async createQuiz(
		@CurrentUser('id') userId: string,
		@Body() dto: CreateQuizDto
	) {
		return this.quizService.createQuiz(userId, dto);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch(':id')
	async updateQuiz(
		@CurrentUser('id') userId: string,
		@Param('id') quizId: string,
		@Body() dto: UpdateQuizDto
	) {
		return this.quizService.updateQuiz(userId, quizId, dto);
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
		@Param('id') quizId: string,
		@UploadedFile() file?: Express.Multer.File
	) {
		return this.quizService.uploadButtonImage(userId, quizId, file);
	}

	@HttpCode(200)
	@Auth()
	@Delete(':id')
	async deleteQuiz(
		@CurrentUser('id') userId: string,
		@Param('id') quizId: string
	) {
		return this.quizService.deleteQuiz(userId, quizId);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/stats')
	async getLeadsStats(
		@CurrentUser('id') userId: string,
		@Param('id') quizId: string
	) {
		return this.quizService.getLeadsStats(userId, quizId);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/export')
	async exportLeads(
		@CurrentUser('id') userId: string,
		@Param('id') quizId: string,
		@Query('format') format: string,
		@Res() res: Response
	) {
		const fmt = format === 'xlsx' ? 'xlsx' : 'csv';
		const result = await this.quizService.exportLeads(userId, quizId, fmt);
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
		@Param('id') quizId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.quizService.getLeads(
			userId,
			quizId,
			page ? parseInt(page) : 1,
			limit ? parseInt(limit) : 50
		);
	}
}
