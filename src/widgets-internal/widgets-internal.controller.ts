import {
	Body,
	Controller,
	Headers,
	HttpCode,
	Post,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import {
	WIDGETS_AUTH_INTROSPECTION_PATH,
	WIDGETS_OWNER_DIRECTORY_PATH,
	WIDGETS_OWNER_SEARCH_PATH
} from './widgets-internal.constants';
import { WidgetsAuthIntrospectionService } from './widgets-auth-introspection.service';
import {
	ResolveWidgetOwnersDto,
	SearchWidgetOwnersDto
} from './widgets-owner-directory.dto';
import { WidgetsOwnerDirectoryService } from './widgets-owner-directory.service';
import { WidgetsInternalTokenGuard } from './widgets-internal-token.guard';

@Controller()
@UseGuards(WidgetsInternalTokenGuard)
export class WidgetsInternalController {
	constructor(
		private readonly authIntrospection: WidgetsAuthIntrospectionService,
		private readonly owners: WidgetsOwnerDirectoryService
	) {}

	@Post(WIDGETS_AUTH_INTROSPECTION_PATH)
	@HttpCode(200)
	introspect(@Headers('authorization') authorization?: string) {
		return this.authIntrospection.introspect(authorization);
	}

	@Post(WIDGETS_OWNER_DIRECTORY_PATH)
	@HttpCode(200)
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	)
	resolveOwners(@Body() dto: ResolveWidgetOwnersDto) {
		return this.owners.resolve(dto.userIds);
	}

	@Post(WIDGETS_OWNER_SEARCH_PATH)
	@HttpCode(200)
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	)
	searchOwners(@Body() dto: SearchWidgetOwnersDto) {
		return this.owners.search(dto);
	}
}
