import { publicWidgetKeyPipe } from '@/widget/public-widget-key.pipe';
import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller()
export class CallbackPublicController {
	@Get('page-callback/:key')
	serveCallbackPage(
		@Param('key', publicWidgetKeyPipe) key: string,
		@Res() res: Response
	) {
		res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
		res.setHeader('X-Frame-Options', 'SAMEORIGIN');

		const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Обратный звонок — WinWidget</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d0d1a; min-height: 100vh; }
  </style>
</head>
<body>
  <script>window.wincallbackAutoOpen = true;</script>
  <script src="/widgets/callback.js" data-key="${key}" async></script>
</body>
</html>`;

		res.status(200).type('text/html').send(html);
	}
}
