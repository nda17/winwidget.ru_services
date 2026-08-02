import {
	ReportingAdminGuard,
	ReportingApiGuard,
	RequireReportingRole
} from '../auth/reporting-auth.guard';
import { UpdateDailySummarySettingsDto } from './daily-summary-settings.dto';
import { DailySummarySettingsService } from './daily-summary-settings.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Req,
	UseGuards
} from '@nestjs/common';
import type { ReportingRequest } from '../auth/reporting-request';

@Controller('/api/v1/admin/reporting/daily-summary/settings')
@UseGuards(ReportingApiGuard, ReportingAdminGuard)
@RequireReportingRole('ADMIN')
export class DailySummarySettingsController {
	constructor(private readonly settings: DailySummarySettingsService) {}

	@Get()
	@HttpCode(200)
	getSettings() {
		return this.settings.getSettings();
	}

	@Patch()
	@HttpCode(200)
	updateSettings(
		@Body() dto: UpdateDailySummarySettingsDto,
		@Req() request: ReportingRequest
	) {
		if (!request.reportingActor) {
			throw new Error('Reporting actor is missing after authorization');
		}
		return this.settings.updateSettings(
			dto,
			request.reportingActor.subject
		);
	}
}
