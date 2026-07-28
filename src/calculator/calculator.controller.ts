import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CalculatorService } from '@/calculator/calculator.service';
import { CreateCalculatorDto } from '@/calculator/dto/create-calculator.dto';
import { UpdateCalculatorDto } from '@/calculator/dto/update-calculator.dto';
import { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES } from '@/file/file.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	ParseIntPipe,
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

@Controller('calculators')
export class CalculatorController {
	constructor(private readonly calculatorService: CalculatorService) {}

	@HttpCode(200)
	@Auth()
	@Get()
	getMyCalculators(@CurrentUser('id') userId: string) {
		return this.calculatorService.getMyCalculators(userId);
	}

	@HttpCode(201)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post()
	createCalculator(
		@CurrentUser('id') userId: string,
		@Body() dto: CreateCalculatorDto
	) {
		return this.calculatorService.createCalculator(userId, dto);
	}

	@HttpCode(200)
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch(':id')
	updateCalculator(
		@CurrentUser('id') userId: string,
		@Param('id') calculatorId: string,
		@Body() dto: UpdateCalculatorDto
	) {
		return this.calculatorService.updateCalculator(
			userId,
			calculatorId,
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
	uploadButtonImage(
		@CurrentUser('id') userId: string,
		@Param('id') calculatorId: string,
		@Body('expectedDraftRevision', ParseIntPipe)
		expectedDraftRevision: number,
		@UploadedFile() file?: Express.Multer.File
	) {
		return this.calculatorService.uploadButtonImage(
			userId,
			calculatorId,
			file,
			expectedDraftRevision
		);
	}

	@HttpCode(200)
	@Auth()
	@Delete(':id')
	deleteCalculator(
		@CurrentUser('id') userId: string,
		@Param('id') calculatorId: string
	) {
		return this.calculatorService.deleteCalculator(userId, calculatorId);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/stats')
	getLeadsStats(
		@CurrentUser('id') userId: string,
		@Param('id') calculatorId: string
	) {
		return this.calculatorService.getLeadsStats(userId, calculatorId);
	}

	@HttpCode(200)
	@Auth()
	@Get(':id/leads/export')
	async exportLeads(
		@CurrentUser('id') userId: string,
		@Param('id') calculatorId: string,
		@Query('format') format: string,
		@Res() res: Response
	) {
		const result = await this.calculatorService.exportLeads(
			userId,
			calculatorId,
			format === 'xlsx' ? 'xlsx' : 'csv'
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
	getLeads(
		@CurrentUser('id') userId: string,
		@Param('id') calculatorId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.calculatorService.getLeads(
			userId,
			calculatorId,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 50
		);
	}
}
