import {
	ReportingAdminGuard,
	ReportingApiGuard,
	RequireReportingRole
} from '../auth/reporting-auth.guard';
import { ReportingAnalyticsService } from './reporting-analytics.service';
import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';

@Controller('/api/v1/admin/reporting')
@UseGuards(ReportingApiGuard, ReportingAdminGuard)
@RequireReportingRole('ADMIN')
export class ReportingAnalyticsController {
	constructor(private readonly analytics: ReportingAnalyticsService) {}

	@Get('/dashboard')
	@HttpCode(200)
	getDashboard() {
		return this.analytics.getDashboard();
	}

	@Get('/overview')
	@HttpCode(200)
	getOverview() {
		return this.analytics.getOverview();
	}

	@Get('/registrations-by-month')
	@HttpCode(200)
	getRegistrationsByMonth() {
		return this.analytics.getRegistrationsByMonth();
	}
}
