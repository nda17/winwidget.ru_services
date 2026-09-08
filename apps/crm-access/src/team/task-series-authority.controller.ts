import {
	Body,
	Controller,
	ForbiddenException,
	Header,
	Headers,
	HttpCode,
	Post,
	UseGuards
} from '@nestjs/common';
import { CrmInternalGuard } from '../authorization/crm-internal.guard';
import {
	parseTaskSeriesAuthority,
	TaskSeriesAuthorityService
} from './task-series-authority.service';

@Controller('internal/v1/crm-access')
@UseGuards(CrmInternalGuard)
export class TaskSeriesAuthorityController {
	constructor(private readonly service: TaskSeriesAuthorityService) {}

	@Post('task-series-authority')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	authorize(
		@Headers('x-winwidget-service') caller: string,
		@Body() body: unknown
	) {
		if (caller !== 'crm-sales')
			throw new ForbiddenException('Only Sales can authorize task series');
		return this.service.authorize(parseTaskSeriesAuthority(body));
	}
}
