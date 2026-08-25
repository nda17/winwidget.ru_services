import {
	CloseNotificationDeliveryFailureDto,
	NotificationDeliveryFailuresQueryDto,
	RetryNotificationDeliveryFailureDto
} from './notification-delivery-control.dto';
import { NotificationDeliveryControlService } from './notification-delivery-control.service';
import { NotificationDeliveryInternalTokenGuard } from './notification-delivery-internal-token.guard';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';

@Controller('internal/notification-delivery')
@UseGuards(NotificationDeliveryInternalTokenGuard)
@UsePipes(
	new ValidationPipe({
		transform: true,
		whitelist: true,
		forbidNonWhitelisted: true
	})
)
export class NotificationDeliveryControlController {
	constructor(
		private readonly controlService: NotificationDeliveryControlService
	) {}

	@Get('overview')
	@HttpCode(200)
	getOverview() {
		return this.controlService.getOverview();
	}

	@Get('failures')
	@HttpCode(200)
	getFailures(@Query() query: NotificationDeliveryFailuresQueryDto) {
		return this.controlService.getFailures(query);
	}

	@Get('failures/:id')
	@HttpCode(200)
	getFailure(@Param('id', new ParseUUIDPipe()) id: string) {
		return this.controlService.getFailure(id);
	}

	@Post('failures/:id/retry')
	@HttpCode(200)
	retryFailure(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() dto: RetryNotificationDeliveryFailureDto
	) {
		return this.controlService.retryFailure(id, dto.actorId);
	}

	@Post('failures/:id/close')
	@HttpCode(200)
	closeFailure(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() dto: CloseNotificationDeliveryFailureDto
	) {
		return this.controlService.closeFailure(id, dto.actorId, dto.comment);
	}
}
