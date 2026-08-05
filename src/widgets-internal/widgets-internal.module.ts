import { AuthModule } from '@/auth/auth.module';
import { Module } from '@nestjs/common';
import { WidgetsAuthIntrospectionService } from './widgets-auth-introspection.service';
import { WidgetsInternalController } from './widgets-internal.controller';
import { WidgetsInternalTokenGuard } from './widgets-internal-token.guard';
import { WidgetsOwnerDirectoryService } from './widgets-owner-directory.service';

@Module({
	imports: [AuthModule],
	controllers: [WidgetsInternalController],
	providers: [
		WidgetsInternalTokenGuard,
		WidgetsAuthIntrospectionService,
		WidgetsOwnerDirectoryService
	]
})
export class WidgetsInternalModule {}
