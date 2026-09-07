import {
	Controller,
	Get,
	Header,
	Module,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmSalesPrismaModule } from '../prisma/crm-sales-prisma.module';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { ReminderDeliveryService } from './reminder-delivery.service';
import { ReminderRecipientsClient } from './reminder-recipients.client';
import { ReminderReadinessService } from './reminder-readiness.service';
import { ReminderRabbitService } from './reminder-rabbit.service';
import { ReminderRuntimeService } from './reminder-runtime.service';

@Controller('health')
class ReminderRuntimeHealthController {
	constructor(
		private readonly runtime: ReminderRuntimeService,
		private readonly prisma: CrmSalesPrismaService
	) {}
	@Get('live')
	@Header('Cache-Control', 'no-store')
	live() {
		return {
			status: 'ok',
			service: 'crm-sales-reminders',
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
	@Get('ready')
	@Header('Cache-Control', 'no-store')
	async ready() {
		const identity = await this.prisma.serviceIdentity.findUnique({
			where: { id: 'singleton' }
		});
		if (
			identity?.serviceName !== 'crm-sales-service' ||
			!this.runtime.isReady()
		)
			throw new ServiceUnavailableException('CRM reminders are not ready');
		return { ...this.live(), status: 'ready' };
	}
}
@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmSalesPrismaModule
	],
	controllers: [ReminderRuntimeHealthController],
	providers: [
		ReminderRecipientsClient,
		ReminderReadinessService,
		ReminderDeliveryService,
		ReminderRabbitService,
		ReminderRuntimeService
	]
})
export class ReminderRuntimeModule {}
