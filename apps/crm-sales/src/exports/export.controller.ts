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
import { SalesExportService } from './export.service';
import { exportHeaders, ExportFormat } from './export-format';
export class ExportQuery {
	@IsUUID('4') workspaceId!: string;
	@IsIn(['json', 'csv']) format!: ExportFormat;
}
export class ExportEntity {
	@IsIn(['deals', 'tasks']) entity!: 'deals' | 'tasks';
}
@Controller('crm/sales/exports')
export class SalesExportController {
	constructor(private readonly exports: SalesExportService) {}
	@Get('v2/tasks')
	async downloadTasksV2(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: ExportQuery,
		@Req() request: Request,
		@Res() response: Response
	) {
		return this.respond(bearer, 'tasks', query, request, response, 2);
	}

	@Get(':entity')
	async download(
		@Headers('authorization') bearer: string | undefined,
		@Param() params: ExportEntity,
		@Query() query: ExportQuery,
		@Req() request: Request,
		@Res() response: Response
	) {
		return this.respond(
			bearer,
			params.entity,
			query,
			request,
			response,
			1
		);
	}

	private async respond(
		bearer: string | undefined,
		entity: ExportEntity['entity'],
		query: ExportQuery,
		request: Request,
		response: Response,
		schemaVersion: 1 | 2
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
			const file =
				schemaVersion === 2
					? await this.exports.prepareTasksV2(
							bearer,
							query.workspaceId,
							query.format,
							abort.signal
						)
					: await this.exports.prepare(
							bearer,
							query.workspaceId,
							entity,
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
