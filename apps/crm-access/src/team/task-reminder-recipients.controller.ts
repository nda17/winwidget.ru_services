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
	parseTaskReminderRecipients,
	TaskReminderRecipientsService
} from './task-reminder-recipients.service';

@Controller('internal/v1/crm-access')
@UseGuards(CrmInternalGuard)
export class TaskReminderRecipientsController {
	constructor(private readonly service: TaskReminderRecipientsService) {}
	@Post('task-reminder-recipients')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	recipients(
		@Headers('x-winwidget-service') caller: string,
		@Body() body: unknown
	) {
		if (caller !== 'crm-sales')
			throw new ForbiddenException(
				'Only Sales can resolve task reminder recipients'
			);
		return this.service.recipients(parseTaskReminderRecipients(body));
	}
}
