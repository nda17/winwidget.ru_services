import { publicWidgetKeyPipe } from '@/widget/public-widget-key.pipe';
import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller()
export class StopOfferPublicController {
	@Get('page-stop-offer/:key')
	serveStopOfferPage(
		@Param('key', publicWidgetKeyPipe) key: string,
		@Res() res: Response
	) {
		res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
		res.setHeader('X-Frame-Options', 'SAMEORIGIN');
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		return res.send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Стоп-оффер — WinWidget</title>
  <style>
    html,body{margin:0;min-height:100%;background:#0d0d1a;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  </style>
</head>
<body>
  <script>window.winstopofferAutoOpen = true;</script>
  <script src="/widgets/stop-offer.js" data-key="${key}" async></script>
</body>
</html>`);
	}
}
