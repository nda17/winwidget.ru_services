import { Global, Module } from '@nestjs/common';
import { CrmAccessRuntimeService } from './crm-access-runtime.service';

@Global()
@Module({
	providers: [CrmAccessRuntimeService],
	exports: [CrmAccessRuntimeService]
})
export class CrmAccessRuntimeModule {}
