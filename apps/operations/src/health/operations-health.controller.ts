import {
	Controller,
	Get,
	Header,
	HttpCode,
	UseGuards
} from '@nestjs/common';
import {
	OperationsAuth,
	OperationsAuthGuard
} from '../auth/operations-auth.guard';
import { OperationsHealthService } from './operations-health.service';

@Controller('health')
export class OperationsHealthController {
	constructor(private readonly health: OperationsHealthService) {}

	@Get('live')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	live() {
		return this.health.liveness();
	}

	@Get('deployment')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	deployment() {
		return this.health.deployment();
	}

	@Get('ready')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	ready() {
		return this.health.readiness();
	}

	@Get('admin')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@OperationsAuth(['ADMIN'])
	@UseGuards(OperationsAuthGuard)
	admin() {
		return this.health.admin();
	}
}
