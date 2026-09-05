import { MODULE_METADATA } from '@nestjs/common/constants';
import { CrmIntakeModule } from './crm-intake.module';
import { CrmIntakePrismaModule } from './prisma/crm-intake-prisma.module';
import { CrmIntakePrismaService } from './prisma/crm-intake-prisma.service';
import { WidgetSourceController } from './widget-sources/widget-source.controller';
import { WidgetControlConfig } from './widget-sources/widget-control.config';
import { WidgetsControlClient } from './widget-sources/widgets-control.client';
import { WidgetTransferClient } from './widget-transfers/widget-transfer.client';
import { WidgetTransferWorker } from './widget-transfers/widget-transfer.worker';
import { WidgetTransferPublisher } from './widget-transfers/widget-transfer.publisher';
import { WidgetTransferController } from './widget-transfers/widget-transfer.controller';

describe('CrmIntakeModule', () => {
	it('does not instantiate Widgets controllers or credentials when default off', () => {
		expect(
			Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CrmIntakeModule)
		).not.toContain(WidgetSourceController);
		const providers = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmIntakeModule
		);
		expect(providers).not.toContain(WidgetControlConfig);
		expect(providers).not.toContain(WidgetsControlClient);
		expect(providers).not.toContain(WidgetTransferClient);
		expect(providers).not.toContain(WidgetTransferWorker);
		expect(providers).not.toContain(WidgetTransferPublisher);
		// Previously delivered data remains readable even when new transfers are disabled.
		expect(
			Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CrmIntakeModule)
		).toContain(WidgetTransferController);
	});
	it('imports the global Prisma module exactly once at the root', () => {
		const imports = Reflect.getMetadata(
			MODULE_METADATA.IMPORTS,
			CrmIntakeModule
		) as unknown[];
		expect(
			imports.filter(item => item === CrmIntakePrismaModule)
		).toHaveLength(1);
	});

	it('keeps PrismaService owned only by the global Prisma module', () => {
		const rootProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmIntakeModule
		) as unknown[];
		const prismaProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmIntakePrismaModule
		) as unknown[];
		expect(rootProviders).not.toContain(CrmIntakePrismaService);
		expect(prismaProviders).toEqual([CrmIntakePrismaService]);
	});
});
