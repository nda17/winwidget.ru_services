import { AppModule } from '@/app.module';
import { FileModule } from '@/file/file.module';
import { MODULE_METADATA } from '@nestjs/common/constants';

describe('legacy generic file route retirement', () => {
	it('does not register FileModule in the Core HTTP application', () => {
		const imports =
			(Reflect.getMetadata(
				MODULE_METADATA.IMPORTS,
				AppModule
			) as unknown[]) || [];

		expect(imports).not.toContain(FileModule);
	});
});
