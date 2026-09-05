import {
	Controller,
	Get,
	Headers,
	Param,
	Query,
	Req,
	Res,
	UnauthorizedException
} from '@nestjs/common';
import { IsIn, IsUUID } from 'class-validator';
import type { Request, Response } from 'express';
import { IntakeExportService } from './export.service';
import { exportHeaders, ExportFormat } from './export-format';
export class ExportQuery {
	@IsUUID('4') workspaceId!: string;
	@IsIn(['json', 'csv']) format!: ExportFormat;
}
export class ExportEntity {
	@IsIn(['inbox']) entity!: 'inbox';
}
@Controller('crm/intake/exports')
export class IntakeExportController {
	constructor(private readonly exports: IntakeExportService) {}
	@Get(':entity')
	async download(
		@Headers('authorization') bearer: string | undefined,
		@Param() params: ExportEntity,
		@Query() query: ExportQuery,
		@Req() request: Request,
		@Res() response: Response
	) {
		if (!bearer || !/^Bearer [^\s]{1,16384}$/i.test(bearer))
			throw new UnauthorizedException('A user session is required');
		const abort = new AbortController();
		const aborted = () => abort.abort();
		const closed = () => {
			if (!response.writableEnded) abort.abort();
		};
		request.once('aborted', aborted);
		response.once('close', closed);
		try {
			const file = await this.exports.prepare(
				bearer,
				query.workspaceId,
				params.entity,
				query.format,
				abort.signal
			);
			if (abort.signal.aborted || response.destroyed) return;
			response.status(200).set(exportHeaders(file)).end(file.body);
		} finally {
			request.off('aborted', aborted);
			response.off('close', closed);
		}
	}
}
