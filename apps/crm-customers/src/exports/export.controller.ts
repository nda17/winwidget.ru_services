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
import { CustomersExportService } from './export.service';
import { exportHeaders, ExportFormat } from './export-format';
export class ExportQuery {
	@IsUUID('4') workspaceId!: string;
	@IsIn(['json', 'csv']) format!: ExportFormat;
}
export class ExportEntity {
	@IsIn(['contacts', 'companies']) entity!: 'contacts' | 'companies';
}
@Controller('crm/customers/exports')
export class CustomersExportController {
	constructor(private readonly exports: CustomersExportService) {}
	@Get('v2/contacts')
	async downloadContactsV2(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: ExportQuery,
		@Req() request: Request,
		@Res() response: Response
	) {
		return this.send(bearer, 'contacts', query, request, response, 2);
	}

	@Get('v2/companies')
	async downloadCompaniesV2(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: ExportQuery,
		@Req() request: Request,
		@Res() response: Response
	) {
		return this.send(bearer, 'companies', query, request, response, 2);
	}

	@Get(':entity')
	async download(
		@Headers('authorization') bearer: string | undefined,
		@Param() params: ExportEntity,
		@Query() query: ExportQuery,
		@Req() request: Request,
		@Res() response: Response
	) {
		return this.send(bearer, params.entity, query, request, response);
	}

	private async send(
		bearer: string | undefined,
		entity: 'contacts' | 'companies',
		query: ExportQuery,
		request: Request,
		response: Response,
		schemaVersion: 1 | 2 = 1
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
				entity,
				query.format,
				abort.signal,
				schemaVersion
			);
			if (abort.signal.aborted || response.destroyed) return;
			response.status(200).set(exportHeaders(file)).end(file.body);
		} finally {
			request.off('aborted', aborted);
			response.off('close', closed);
		}
	}
}
