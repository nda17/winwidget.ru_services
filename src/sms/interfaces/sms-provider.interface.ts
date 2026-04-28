export type SendSmsOptions = {
	to: string;
	text: string;
};

export interface SmsProvider {
	send(options: SendSmsOptions): Promise<void>;
}
