export const SUPPORT_WEBHOOK_MAX_BYTES = 512 * 1024;

export interface TelegramUser {
	id: number;
	is_bot?: boolean;
	username?: string;
	first_name?: string;
	last_name?: string;
}

export interface TelegramChat {
	id: number | string;
	type?: string;
}

export interface TelegramMessage {
	message_id?: number;
	message_thread_id?: number;
	text?: string;
	caption?: string;
	chat: TelegramChat;
	from?: TelegramUser;
	reply_to_message?: TelegramMessage;
}

export interface TelegramSupportUpdate {
	update_id: number;
	message?: TelegramMessage;
}
