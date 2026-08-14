import {
	Body,
	Controller,
	HttpCode,
	Post,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { WidgetsAdminMonitoringService } from '../monitoring/widgets-admin-monitoring.service';
import { OwnerOverviewDto } from './widgets-internal.controller';
import { WidgetsIdentityGuard } from './widgets-identity.guard';

@Controller('internal/v1/identity/widgets')
@UseGuards(WidgetsIdentityGuard)
@UsePipes(
	new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
)
export class WidgetsIdentityController {
	constructor(
		private readonly monitoring: WidgetsAdminMonitoringService
	) {}

	@Post('admin-owner-overview')
	@HttpCode(200)
	overview(@Body() dto: OwnerOverviewDto) {
		return this.monitoring.ownerOverview(dto.userId);
	}
}
