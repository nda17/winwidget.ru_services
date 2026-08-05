import {
	BadRequestException,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { EntitlementPlan } from '@prisma/widgets-client';
import * as XLSX from 'xlsx';
import { WidgetsQuotaService } from '../quota/widgets-quota.service';
import { WidgetsAccessService } from './widgets-access.service';
import { normalizeWidgetConfig } from './widgets-config-normalizer';
import { WidgetsDomainRepository } from './widgets-domain.repository';
import { asJsonObject, WidgetType } from './widgets-domain.types';
import { WidgetsTypeRegistryService } from './widgets-type-registry.service';

@Injectable()
export class WidgetsLeadQueryService {
	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly access: WidgetsAccessService,
		private readonly quota: WidgetsQuotaService,
		private readonly registry: WidgetsTypeRegistryService
	) {}

	async list(
		type: WidgetType,
		widgetId: string,
		userId: string,
		page: number,
		limit: number
	) {
		const widget = await this.access.owned(type, widgetId, userId);
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10_000) : 50;
		const { leads, total } = await this.repository.listLeads(
			type,
			widgetId,
			normalizedPage,
			normalizedLimit
		);
		const adapter = this.registry.for(type);
		const config = asJsonObject(
			normalizeWidgetConfig(type, widget.config)
		);
		return {
			leads: leads.map(lead => adapter.presentLead(lead, config)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async stats(type: WidgetType, widgetId: string, userId: string) {
		const widget = await this.access.owned(type, widgetId, userId);
		await this.assertPaidFeature(
			userId,
			'Аналитика недоступна на тарифе Easy'
		);
		const aggregate = await this.repository.aggregateLeadStats(
			type,
			widgetId
		);
		const result = this.registry
			.for(type)
			.stats(
				aggregate,
				asJsonObject(normalizeWidgetConfig(type, widget.config))
			);
		if (!result) {
			throw new BadRequestException(
				'Аналитика недоступна для этого типа виджета'
			);
		}
		return result;
	}

	async export(
		type: WidgetType,
		widgetId: string,
		userId: string,
		format: 'csv' | 'xlsx'
	) {
		const widget = await this.access.owned(type, widgetId, userId);
		await this.assertPaidFeature(
			userId,
			'Экспорт заявок недоступен на тарифе Easy'
		);
		const leads = await this.repository.allLeads(type, widgetId);
		const spec = this.registry
			.for(type)
			.exportSpec(
				leads,
				asJsonObject(normalizeWidgetConfig(type, widget.config))
			);
		const safeName = widget.name.replace(/[^\w\u0400-\u04FF-]/g, '_');
		if (format === 'xlsx') {
			const headers = spec.xlsxHeaders || spec.headers;
			const rows = spec.rows.map(row =>
				Object.fromEntries(
					headers.map((header, index) => [header, row[index]])
				)
			);
			const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
			const workbook = XLSX.utils.book_new();
			XLSX.utils.book_append_sheet(workbook, sheet, 'Заявки');
			return {
				data: XLSX.write(workbook, {
					type: 'buffer',
					bookType: 'xlsx'
				}) as Buffer,
				contentType:
					'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				filename: `${spec.filenamePrefix}_${safeName}.xlsx`
			};
		}
		const csv = [spec.headers, ...spec.rows]
			.map(row => row.map(value => this.escapeCsv(value)).join(','))
			.join('\r\n');
		return {
			data: Buffer.from(`\uFEFF${csv}`, 'utf8'),
			contentType: 'text/csv; charset=utf-8',
			filename: `${spec.filenamePrefix}_${safeName}.csv`
		};
	}

	private async assertPaidFeature(
		userId: string,
		message: string
	): Promise<void> {
		const snapshot = await this.quota.snapshot(userId);
		if (snapshot.entitlement.plan === EntitlementPlan.EASY) {
			throw new ForbiddenException(message);
		}
	}

	private escapeCsv(value: unknown): string {
		const raw = String(value ?? '');
		const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
		return /[,"\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
	}
}
