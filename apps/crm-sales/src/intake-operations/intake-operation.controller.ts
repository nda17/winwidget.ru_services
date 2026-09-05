import {
	BadRequestException,
	Body,
	Controller,
	Headers,
	HttpCode,
	Post,
	UseGuards
} from '@nestjs/common';
import {
	CloseIntakeOperation,
	ExecuteIntakeOperation,
	IntakeOperationBinding
} from './intake-operation.dto';
import { IntakeOperationGuard } from './intake-operation.guard';
import { IntakeOperationService } from './intake-operation.service';

@Controller('internal/v1/crm-sales/intake-operations')
@UseGuards(IntakeOperationGuard)
export class IntakeOperationController {
	constructor(private readonly service: IntakeOperationService) {}
	@Post('read')
	@HttpCode(200)
	read(@Body() body: IntakeOperationBinding) {
		return this.service.read(body);
	}
	@Post('execute')
	@HttpCode(200)
	execute(
		@Body() body: ExecuteIntakeOperation,
		@Headers('idempotency-key') key?: string
	) {
		if (key !== body.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.service.execute(body);
	}
	@Post('close')
	@HttpCode(200)
	close(
		@Body() body: CloseIntakeOperation,
		@Headers('idempotency-key') key?: string
	) {
		if (key !== body.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.service.close(body);
	}
}
