import { ConfigService } from '@nestjs/config';

export const isDev = (configService: ConfigService) =>
	configService.get('MODE') === 'development';
