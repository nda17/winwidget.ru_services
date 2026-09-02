import { MODULE_METADATA } from '@nestjs/common/constants';
import { CrmCustomersModule } from './crm-customers.module';
import { CrmCustomersPrismaModule } from './prisma/crm-customers-prisma.module';
import { CrmCustomersPrismaService } from './prisma/crm-customers-prisma.service';

describe('CrmCustomersModule', () => {
	it('imports the global Prisma module exactly once at the root', () => {
		const imports = Reflect.getMetadata(
			MODULE_METADATA.IMPORTS,
			CrmCustomersModule
		) as unknown[];
		expect(
			imports.filter(item => item === CrmCustomersPrismaModule)
		).toHaveLength(1);
	});

	it('keeps PrismaService owned only by the global Prisma module', () => {
		const rootProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmCustomersModule
		) as unknown[];
		const prismaProviders = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			CrmCustomersPrismaModule
		) as unknown[];
		expect(rootProviders).not.toContain(CrmCustomersPrismaService);
		expect(prismaProviders).toEqual([CrmCustomersPrismaService]);
	});
});
