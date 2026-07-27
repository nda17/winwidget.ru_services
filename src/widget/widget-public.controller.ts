import { publicWidgetKeyPipe } from '@/widget/public-widget-key.pipe';
import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller()
export class WidgetPublicController {
	/**
	 * Serves widget loader JS: GET /widget/:key
	 * Client embeds: <script src="https://winwidget.ru/widget/KEY"></script>
	 * The loader sets window.winwidget and loads /widgets/wheel.js
	 */
	@Get('widget/:key')
	async serveWidgetJs(
		@Param('key', publicWidgetKeyPipe) key: string,
		@Res() res: Response
	) {
		const serializedKey = JSON.stringify(key);

		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

		const js = `(function(){
  if(window.winwidget===${serializedKey})return;
  window.winwidget=${serializedKey};
  var loader=document.currentScript;
  if(!loader||!loader.src)return;
  var s=document.createElement('script');
  var assetUrl=new URL('/widgets/wheel.js',loader.src);
  assetUrl.searchParams.set('v','${Date.now()}');
  s.src=assetUrl.href;
  s.async=true;
  document.head.appendChild(s);
})();`;

		res.status(200).type('application/javascript').send(js);
	}

	/**
	 * Serves widget preview page: GET /page-wheel/:key
	 * Direct link — standalone page with the widget
	 */
	@Get('page-wheel/:key')
	async serveWidgetPage(
		@Param('key', publicWidgetKeyPipe) key: string,
		@Res() res: Response
	) {
		const serializedKey = JSON.stringify(key);

		res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
		res.setHeader('X-Frame-Options', 'SAMEORIGIN');

		const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Виджет — WinWidget</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d0d1a; min-height: 100vh; }
  </style>
</head>
<body>
  <script>window.winwidget = ${serializedKey}; window.winwidgetAutoOpen = true;</script>
  <script src="/widgets/wheel.js" async></script>
</body>
</html>`;

		res.status(200).type('text/html').send(html);
	}
}
