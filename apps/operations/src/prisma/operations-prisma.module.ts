import { Global, Module } from '@nestjs/common';
import { OperationsPrismaService } from './operations-prisma.service';

@Global()
@Module({
	providers: [OperationsPrismaService],
	exports: [OperationsPrismaService]
})
export class OperationsPrismaModule {}
