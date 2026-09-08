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
	IntakeSlaAuthorityService,
	parseIntakeSlaAuthority
} from './intake-sla-authority.service';
import {
	IntakeSlaRecipientsService,
	parseIntakeSlaRecipients
} from './intake-sla-recipients.service';

@Controller('internal/v1/crm-access')
@UseGuards(CrmInternalGuard)
export class IntakeSlaAuthorityController {
	constructor(
		private readonly service: IntakeSlaAuthorityService,
		private readonly recipients: IntakeSlaRecipientsService
	) {}
	@Post('intake-sla-recipients')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	resolveRecipients(
		@Headers('x-winwidget-service') caller: string,
		@Body() body: unknown
	) {
		if (caller !== 'crm-intake')
			throw new ForbiddenException(
				'Only Intake can authorize Intake SLA recipients'
			);
		return this.recipients.recipients(parseIntakeSlaRecipients(body));
	}
	@Post('intake-sla-authority')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	authorize(
		@Headers('x-winwidget-service') caller: string,
		@Body() body: unknown
	) {
		if (caller !== 'crm-intake')
			throw new ForbiddenException('Only Intake can authorize Intake SLA');
		return this.service.authorize(parseIntakeSlaAuthority(body));
	}
}
