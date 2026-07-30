import { Equals, IsIn } from 'class-validator';

export const CAMPAIGNS_AUDIENCE_CHANNELS = ['EMAIL', 'TELEGRAM'] as const;
export const CAMPAIGNS_AUDIENCES = ['ALL', 'ACTIVE_SUBSCRIBERS'] as const;

export type CampaignsAudienceChannel =
	(typeof CAMPAIGNS_AUDIENCE_CHANNELS)[number];
export type CampaignsAudience = (typeof CAMPAIGNS_AUDIENCES)[number];

export class CampaignsAudienceExportDto {
	@Equals(1)
	schemaVersion: 1;

	@IsIn(CAMPAIGNS_AUDIENCE_CHANNELS)
	channel: CampaignsAudienceChannel;

	@IsIn(CAMPAIGNS_AUDIENCES)
	audience: CampaignsAudience;
}
