import { WidgetService } from '@/widget/widget.service';
import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

@Controller()
export class WidgetPublicController {
	constructor(private readonly widgetService: WidgetService) {}

	/**
	 * Serves widget loader JS: GET /widget/:key
	 * Client embeds: <script src="https://winwidget.ru/widget/KEY"></script>
	 * The loader sets window.winwidget and loads /widgets/wheel.js
	 */
	@Get('widget/:key')
	async serveWidgetJs(
		@Param('key') key: string,
		@Req() req: Request,
		@Res() res: Response
	) {
		const origin = `${req.protocol}://${req.get('host')}`;

		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

		const js = `(function(){
  if(window.winwidget==='${key}')return;
  window.winwidget='${key}';
  var s=document.createElement('script');
  s.src='${origin}/widgets/wheel.js?v=${Date.now()}';
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
		@Param('key') key: string,
		@Req() req: Request,
		@Res() res: Response
	) {
		const origin = `${req.protocol}://${req.get('host')}`;

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
  <script>window.winwidget = '${key}'; window.winwidgetAutoOpen = true;</script>
  <script src="${origin}/widgets/wheel.js" async></script>
</body>
</html>`;

		res.status(200).type('text/html').send(html);
	}
}
