import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminAlertsController } from './admin-alerts/admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts/admin-alerts.service';
import { AdminEventLogController } from './admin-event-log/admin-event-log.controller';
import { AdminEventLogService } from './admin-event-log/admin-event-log.service';
import { IdentityIntrospectionClient } from './auth/identity-introspection.client';
import { OperationsAuthGuard } from './auth/operations-auth.guard';
import { OperationsHealthController } from './health/operations-health.controller';
import { OperationsHealthService } from './health/operations-health.service';
import { OperationsFederationClient } from './federation/operations-federation.client';
import { RabbitMqManagementClient } from './federation/rabbitmq-management.client';
import { OperationsIdentityController } from './internal/operations-identity.controller';
import { OperationsIdentityGuard } from './internal/operations-identity.guard';
import { AdminAuditConsumerService } from './messaging/admin-audit-consumer.service';
import { AdminAuditFailureService } from './messaging/admin-audit-failure.service';
import { AuditReceiptService } from './messaging/audit-receipt.service';
import { OperationsOutboxPublisherService } from './messaging/operations-outbox-publisher.service';
import { OperationsOutboxService } from './messaging/operations-outbox.service';
import { OperationsRabbitMqService } from './messaging/operations-rabbitmq.service';
import { MessagingAdminController } from './messaging-admin/messaging-admin.controller';
import { MessagingAdminService } from './messaging-admin/messaging-admin.service';
import { MaintenanceSchedulerService } from './maintenance/maintenance-scheduler.service';
import { MaintenanceWorkerService } from './maintenance/maintenance-worker.service';
import { DatabaseBackupService } from './maintenance/database-backup.service';
import { DatabaseBackupProvenanceService } from './maintenance/database-backup-provenance.service';
import { OperationalAlertService } from './monitoring/operational-alert.service';
import { OperationsHeartbeatService } from './monitoring/operations-heartbeat.service';
import { OperationsPrismaModule } from './prisma/operations-prisma.module';
import { OperationsPrismaService } from './prisma/operations-prisma.service';
import { ReportingPolicyController } from './reporting-policy/reporting-policy.controller';
import { ReportingPolicyGuard } from './reporting-policy/reporting-policy.guard';
import { ReportingPolicyService } from './reporting-policy/reporting-policy.service';
import { DatabaseRestoreArtifactValidatorService } from './restore/database-restore-artifact-validator.service';
import { DatabaseRestoreAclService } from './restore/database-restore-acl.service';
import { DatabaseRestoreAuthorizationService } from './restore/database-restore-authorization.service';
import { DatabaseRestoreCleanupService } from './restore/database-restore-cleanup.service';
import { DatabaseRestoreController } from './restore/database-restore.controller';
import { DatabaseRestoreExecutorService } from './restore/database-restore-executor.service';
import { DatabaseRestoreMigrationManifestService } from './restore/database-restore-migration-manifest.service';
import { DatabaseRestoreProcessService } from './restore/database-restore-process.service';
import { DatabaseRestoreRecoveryService } from './restore/database-restore-recovery.service';
import { DatabaseRestoreRecoveryExecutorService } from './restore/database-restore-recovery-executor.service';
import { DatabaseRestoreRecoveryStateService } from './restore/database-restore-recovery-state.service';
import { DatabaseRestoreReceiptService } from './restore/database-restore-receipt.service';
import { DatabaseRestoreReleaseAuthorizationService } from './restore/database-restore-release-authorization.service';
import { DatabaseRestoreService } from './restore/database-restore.service';
import { DatabaseRestoreStateService } from './restore/database-restore-state.service';
import { DatabaseRestoreTargetRegistryService } from './restore/database-restore-target-registry.service';
import { DatabaseRestoreWorkerService } from './restore/database-restore-worker.service';
import { DatabaseRestoreWriterFenceService } from './restore/database-restore-writer-fence.service';
import { OperationsRuntimeModule } from './runtime/operations-runtime.module';
import {
	OperationsProcessRole,
	parseOperationsProcessRole
} from './runtime/operations-runtime.service';
import { ScheduledJobsService } from './scheduled-jobs/scheduled-jobs.service';
import { TelegramSettingsController } from './telegram/telegram-settings.controller';
import { TelegramSettingsService } from './telegram/telegram-settings.service';
import { TelegramTransportService } from './telegram/telegram-transport.service';

const PROCESS_ROLE = parseOperationsProcessRole(
	process.env.OPERATIONS_PROCESS_ROLE
);
const API_CONTROLLERS =
	PROCESS_ROLE === 'api'
		? [
				AdminEventLogController,
				OperationsIdentityController,
				AdminAlertsController,
				MessagingAdminController,
				TelegramSettingsController,
				DatabaseRestoreController,
				ReportingPolicyController
			]
		: [];

export function getOperationsRoleScopedProviders(
	role: OperationsProcessRole
) {
	return role === 'api'
		? [OperationsIdentityGuard, ReportingPolicyGuard]
		: [];
}

const ROLE_SCOPED_PROVIDERS =
	getOperationsRoleScopedProviders(PROCESS_ROLE);

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
		...ROLE_SCOPED_PROVIDERS,
		AdminEventLogService,
		OperationsFederationClient,
		RabbitMqManagementClient,
		AdminAlertsService,
		MessagingAdminService,
		OperationsRabbitMqService,
		OperationsOutboxService,
		AuditReceiptService,
		AdminAuditConsumerService,
		AdminAuditFailureService,
		OperationsOutboxPublisherService,
		ScheduledJobsService,
		TelegramSettingsService,
		TelegramTransportService,
		DatabaseBackupService,
		DatabaseBackupProvenanceService,
		DatabaseRestoreTargetRegistryService,
		DatabaseRestoreArtifactValidatorService,
		DatabaseRestoreAclService,
		DatabaseRestoreMigrationManifestService,
		DatabaseRestoreReceiptService,
		DatabaseRestoreReleaseAuthorizationService,
		DatabaseRestoreAuthorizationService,
		DatabaseRestoreProcessService,
		DatabaseRestoreExecutorService,
		DatabaseRestoreWriterFenceService,
		DatabaseRestoreRecoveryExecutorService,
		DatabaseRestoreCleanupService,
		DatabaseRestoreStateService,
		DatabaseRestoreRecoveryService,
		DatabaseRestoreRecoveryStateService,
		DatabaseRestoreService,
		DatabaseRestoreWorkerService,
		ReportingPolicyService,
		MaintenanceSchedulerService,
		MaintenanceWorkerService,
		OperationalAlertService,
		OperationsHeartbeatService,
		OperationsHealthService
	]
})
export class OperationsModule implements OnApplicationShutdown {
	constructor(private readonly prisma: OperationsPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
