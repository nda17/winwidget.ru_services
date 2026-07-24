import { AppModule } from '@/app.module';
import { MaintenanceWorkerModule } from '@/maintenance/maintenance-worker.module';
import { IntegrationWorkerModule } from '@/messaging/integration-worker.module';
import { OutboxPublisherModule } from '@/messaging/outbox-publisher.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
import { Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import {
	GLOBAL_MODULE_METADATA,
	MODULE_METADATA
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

@Injectable()
class FirstPrismaConsumer {
	constructor(readonly prisma: PrismaService) {}
}

@Injectable()
class SecondPrismaConsumer {
	constructor(readonly prisma: PrismaService) {}
}

@Module({
	providers: [FirstPrismaConsumer],
	exports: [FirstPrismaConsumer]
})
class FirstConsumerModule {}

@Module({
	providers: [SecondPrismaConsumer],
	exports: [SecondPrismaConsumer]
})
class SecondConsumerModule {}

@Module({
	imports: [PrismaModule, FirstConsumerModule, SecondConsumerModule]
})
class TestRootModule implements OnApplicationShutdown {
	constructor(private readonly prisma: PrismaService) {}

	onApplicationShutdown() {
		return this.prisma.disconnect();
	}
}

const ROOT_MODULES = [
	AppModule,
	OutboxPublisherModule,
	IntegrationWorkerModule,
	MaintenanceWorkerModule
];

describe('PrismaModule', () => {
	const originalMode = process.env.MODE;
	const originalDevelopmentUrl = process.env.DATABASE_URL_DEVELOPMENT;

	afterEach(() => {
		jest.restoreAllMocks();
		if (originalMode === undefined) delete process.env.MODE;
		else process.env.MODE = originalMode;
		if (originalDevelopmentUrl === undefined) {
			delete process.env.DATABASE_URL_DEVELOPMENT;
		} else {
			process.env.DATABASE_URL_DEVELOPMENT = originalDevelopmentUrl;
		}
	});

	it('is global and is imported once by every application root', () => {
		expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, PrismaModule)).toBe(
			true
		);
		expect(
			Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PrismaModule)
		).toContain(PrismaService);
		expect(
			Reflect.getMetadata(MODULE_METADATA.EXPORTS, PrismaModule)
		).toContain(PrismaService);

		for (const rootModule of ROOT_MODULES) {
			expect(
				Reflect.getMetadata(MODULE_METADATA.IMPORTS, rootModule)
			).toContain(PrismaModule);
			expect(
				Reflect.getMetadata(MODULE_METADATA.PROVIDERS, rootModule) ?? []
			).not.toContain(PrismaService);
			expect(rootModule.prototype.onApplicationShutdown).toEqual(
				expect.any(Function)
			);
		}
	});

	it('shares one client between modules and disconnects it once', async () => {
		process.env.MODE = 'development';
		process.env.DATABASE_URL_DEVELOPMENT =
			'postgresql://postgres:postgres@127.0.0.1:5432/test';
		const connect = jest
			.spyOn(PrismaService.prototype, '$connect')
			.mockResolvedValue();
		const disconnect = jest
			.spyOn(PrismaService.prototype, '$disconnect')
			.mockResolvedValue();
		const moduleRef = await Test.createTestingModule({
			imports: [TestRootModule]
		}).compile();

		await moduleRef.init();

		expect(moduleRef.get(FirstPrismaConsumer).prisma).toBe(
			moduleRef.get(SecondPrismaConsumer).prisma
		);
		expect(connect).toHaveBeenCalledTimes(1);

		await moduleRef.close();

		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it('does not register PrismaService in feature modules', () => {
		const sourceRoot = join(__dirname);
		const allowedFiles = new Set([
			'app.module.ts',
			'maintenance/maintenance-worker.module.ts',
			'messaging/integration-worker.module.ts',
			'messaging/outbox-publisher.module.ts',
			'prisma.module.ts'
		]);
		const offenders = collectModuleFiles(sourceRoot)
			.map(file => ({
				file,
				source: readFileSync(file, 'utf8')
			}))
			.filter(
				({ file, source }) =>
					!allowedFiles.has(relative(sourceRoot, file)) &&
					source.includes('PrismaService')
			)
			.map(({ file }) => relative(sourceRoot, file));

		expect(offenders).toEqual([]);
	});
});

function collectModuleFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectModuleFiles(path);
		return entry.name.endsWith('.module.ts') ? [path] : [];
	});
}
