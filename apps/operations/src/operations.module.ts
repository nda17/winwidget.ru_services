import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminEventLogController } from './admin-event-log/admin-event-log.controller';
import { AdminEventLogService } from './admin-event-log/admin-event-log.service';
import { IdentityIntrospectionClient } from './auth/identity-introspection.client';
import { OperationsAuthGuard } from './auth/operations-auth.guard';
import { OperationsHealthController } from './health/operations-health.controller';
import { OperationsHealthService } from './health/operations-health.service';
import { AdminAuditConsumerService } from './messaging/admin-audit-consumer.service';
import { AuditReceiptService } from './messaging/audit-receipt.service';
import { OperationsOutboxPublisherService } from './messaging/operations-outbox-publisher.service';
import { OperationsOutboxService } from './messaging/operations-outbox.service';
import { OperationsRabbitMqService } from './messaging/operations-rabbitmq.service';
import { NotesController } from './notes/notes.controller';
import { NotesService } from './notes/notes.service';
import { OperationsPrismaModule } from './prisma/operations-prisma.module';
import { OperationsPrismaService } from './prisma/operations-prisma.service';
import { OperationsRuntimeModule } from './runtime/operations-runtime.module';
import { parseOperationsProcessRole } from './runtime/operations-runtime.service';

const PROCESS_ROLE = parseOperationsProcessRole(
	process.env.OPERATIONS_PROCESS_ROLE
);
const API_CONTROLLERS =
	PROCESS_ROLE === 'api' ? [NotesController, AdminEventLogController] : [];

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		OperationsRuntimeModule,
		OperationsPrismaModule
	],
	controllers: [OperationsHealthController, ...API_CONTROLLERS],
	providers: [
		IdentityIntrospectionClient,
		OperationsAuthGuard,
		AdminEventLogService,
		NotesService,
		OperationsRabbitMqService,
		OperationsOutboxService,
		AuditReceiptService,
		AdminAuditConsumerService,
		OperationsOutboxPublisherService,
		OperationsHealthService
	]
})
export class OperationsModule implements OnApplicationShutdown {
	constructor(private readonly prisma: OperationsPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
