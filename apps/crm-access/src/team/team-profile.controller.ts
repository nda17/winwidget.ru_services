import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Post,
	Query
} from '@nestjs/common';
import {
	EmployeeProfileQueryDto,
	UpdateEmployeeProfileDto
} from './team.dto';
import { CrmEmployeeProfileService } from './team-profile.service';

@Controller('crm/access/team/profiles')
export class CrmEmployeeProfileController {
	constructor(private readonly profiles: CrmEmployeeProfileService) {}

	@Get()
	@Header('Cache-Control', 'no-store')
	get(
		@Headers('authorization') token: string | undefined,
		@Query() query: EmployeeProfileQueryDto
	) {
		return this.profiles.get(token, query);
	}

	@Post()
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	update(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: UpdateEmployeeProfileDto
	) {
		if (key !== dto.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.profiles.update(token, dto);
	}
}
