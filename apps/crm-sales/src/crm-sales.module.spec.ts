import { MODULE_METADATA } from '@nestjs/common/constants';
import { CrmSalesModule } from './crm-sales.module';
import { CrmSalesPrismaModule } from './prisma/crm-sales-prisma.module';
import { CrmSalesPrismaService } from './prisma/crm-sales-prisma.service';

describe('CrmSalesModule', () => {
	it('imports the global Prisma module exactly once at the root', () => {
		const imports = Reflect.getMetadata(
			MODULE_METADATA.IMPORTS,
			CrmSalesModule
		) as unknown[];
		expect(
			imports.filter(item => item === CrmSalesPrismaModule)
		).toHaveLength(1);
	});

	it('keeps PrismaService owned only by the global Prisma module', () => {
		const rootProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmSalesModule
		) as unknown[];
		const prismaProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmSalesPrismaModule
		) as unknown[];
		expect(rootProviders).not.toContain(CrmSalesPrismaService);
		expect(prismaProviders).toEqual([CrmSalesPrismaService]);
	});
});
