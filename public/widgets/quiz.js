(function () {
	'use strict';

	if (window.__winquizScriptRunning) return;
	window.__winquizScriptRunning = true;

	var _currentScript = document.currentScript;

	var API_BASE = (function () {
		try {
			var src = new URL(
				_currentScript && _currentScript.src
					? _currentScript.src
					: location.href
			);
			return src.origin + '/api';
		} catch (e) {
			return 'https://winwidget.ru/api';
		}
	})();

	var KEY =
		(_currentScript && _currentScript.getAttribute('data-key')) || '';
	if (!KEY) return;

	// ─── Floating button ──────────────────────────────────────────────────────

	var quizBtn = document.createElement('div');
	quizBtn.innerHTML = [
		'<div id="wq-btn-icon" style="',
		'filter:drop-shadow(0 6px 20px rgba(71,5,251,0.55)) drop-shadow(0 2px 6px rgba(0,0,0,0.3));',
		'transition:filter 0.4s ease;',
		'">',
		'<svg id="wq-btn-svg" width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">',
		'<circle cx="30" cy="30" r="30" fill="url(#wqGrad)"/>',
		'<circle cx="30" cy="30" r="28" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>',
		'<text x="30" y="38" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="900" fill="white">?</text>',
		'<defs>',
		'<radialGradient id="wqGrad" cx="40%" cy="30%" r="70%">',
		'<stop offset="0%" stop-color="#7c3aed"/>',
		'<stop offset="100%" stop-color="#4705fb"/>',
		'</radialGradient>',
		'</defs>',
		'</svg>',
		'</div>',
		'<div id="wq-btn-label" style="',
		'margin-top:6px;',
		'background:linear-gradient(135deg,#7c3aed,#4705fb);',
		'color:#fff;font-size:11px;font-weight:900;',
		'padding:3px 12px;border-radius:20px;white-space:normal;text-align:center;',
		'letter-spacing:0.8px;text-transform:uppercase;line-height:1.3;',
		'box-shadow:0 3px 12px rgba(71,5,251,0.5);',
		'">Квиз!<br>Приз!</div>'
	].join('');

	quizBtn.style.cssText = [
		'position:fixed',
		'display:none',
		'align-items:center',
		'justify-content:center',
		'flex-direction:column',
		'cursor:pointer',
		'z-index:9999',
		'max-width:calc(100vw - 56px)',
		'transition:opacity 350ms ease,transform 350ms cubic-bezier(.34,1.56,.64,1)',
		'user-select:none',
		'-webkit-tap-highlight-color:transparent'
	].join(';');

	document.body.appendChild(quizBtn);

	// Button animations
	var styleAnim = document.createElement('style');
	styleAnim.textContent = [
		'@keyframes wqBounce{0%,100%{transform:translateY(0) scale(1)}10%{transform:translateY(-16px) scale(1.1)}20%{transform:translateY(0) scale(1)}30%{transform:translateY(-6px) scale(1.04)}40%{transform:translateY(0) scale(1)}}',
		'@keyframes wqSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}',
		'@keyframes wqGlow{0%,100%{filter:drop-shadow(0 6px 20px rgba(71,5,251,0.55)) drop-shadow(0 2px 6px rgba(0,0,0,0.3))}50%{filter:drop-shadow(0 8px 32px rgba(124,58,237,0.9)) drop-shadow(0 4px 16px rgba(71,5,251,0.6)) drop-shadow(0 0 24px rgba(167,139,250,0.4))}}'
	].join('');
	document.head.appendChild(styleAnim);

	var _pulseEnabled = true;
	var _animActive = false;

	function startBtnAnim() {
		if (_animActive) return;
		_animActive = true;
		quizBtn.style.animation =
			'wqBounce 3s ease-in-out infinite,wqSway 4s ease-in-out infinite';
		var icon = quizBtn.querySelector('#wq-btn-icon');
		if (icon && _pulseEnabled)
			icon.style.animation = 'wqGlow 2.5s ease-in-out infinite';
	}

	function stopBtnAnim() {
		_animActive = false;
		quizBtn.style.animation = 'none';
		var icon = quizBtn.querySelector('#wq-btn-icon');
		if (icon) icon.style.animation = 'none';
	}

	setTimeout(startBtnAnim, 4000);

	var _scrollTriggered = false;
	window.addEventListener(
		'scroll',
		function () {
			if (_scrollTriggered) return;
			_scrollTriggered = true;
			quizBtn.animate(
				[
					{ transform: 'translateY(0) rotate(0)' },
					{ transform: 'translateY(-200px) rotate(-8deg)' },
					{ transform: 'translateY(0) rotate(0)' }
				],
				{ duration: 2000, easing: 'cubic-bezier(.34,1.56,.64,1)' }
			);
			startBtnAnim();
		},
		{ passive: true }
	);

	// ─── Shadow DOM host ─────────────────────────────────────────────────────

	var host = document.createElement('div');
	host.id = 'quiz-widget-host';
	document.body.appendChild(host);
	var shadow = host.attachShadow({ mode: 'open' });

	var style = document.createElement('style');
	style.textContent = [
		':host{position:fixed;z-index:100;top:0}',
		'*{box-sizing:border-box;margin:0;padding:0}',

		// wrapper
		'#wq-wrap{width:100vw;height:100dvh;display:none;overflow-x:hidden;overflow-y:auto;justify-content:center;align-items:flex-start;padding:12px}',
		'@supports not (height:100dvh){#wq-wrap{height:100vh}}',
		'.visible{display:flex!important}',
		'.hidden{display:none!important}',

		// overlay
		'#wq-overlay{position:fixed;inset:0;background:rgba(8,4,20,0.86);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);z-index:999;touch-action:none}',

		// card
		'#wq-card{position:relative;z-index:1000;display:flex;flex-direction:column;width:100%;max-width:520px;margin:auto;',
		'background:linear-gradient(160deg,#1a0a2e 0%,#0f0520 100%);',
		'border-radius:24px;padding:32px 24px 28px;',
		'box-shadow:0 0 0 1px rgba(255,255,255,0.07),0 32px 80px rgba(0,0,0,0.6),0 0 80px rgba(71,5,251,0.18);',
		'min-height:calc(100dvh - 24px);justify-content:center;gap:0;',
		'overflow:hidden}',
		'#wq-card::before{content:"";position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);pointer-events:none}',
		'#wq-card::after{content:"";position:absolute;top:-80px;right:-80px;width:240px;height:240px;background:radial-gradient(circle,rgba(124,58,237,0.15) 0%,transparent 70%);pointer-events:none}',

		// close
		'#wq-close{position:absolute;top:14px;right:14px;width:34px;height:34px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s,transform 0.2s,border-color 0.2s;backdrop-filter:blur(4px)}',
		'#wq-close:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.22);transform:scale(1.08) rotate(90deg)}',
		'#wq-close svg{width:14px;height:14px}',
		'#wq-close line{stroke:rgba(255,255,255,0.8);stroke-width:2;stroke-linecap:round}',
		'#wq-brand{position:absolute;top:10px;left:50%;transform:translateX(-50%);font-size:11px;color:rgba(255,255,255,0.3);white-space:nowrap;letter-spacing:0.2px;pointer-events:auto}',
		'#wq-brand a{color:rgba(255,200,50,0.65);text-decoration:none;font-weight:600}',
		'#wq-brand a:hover{color:#ffc832}',

		// progress
		'#wq-progress{display:flex;gap:5px;margin-bottom:22px}',
		'.wq-bar{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);transition:background 0.3s}',
		'.wq-bar.done{background:linear-gradient(90deg,#7c3aed,#4705fb)}',

		// screens
		'.wq-screen{display:none;flex-direction:column;gap:16px;animation:wqFadeIn 0.25s ease}',
		'.wq-screen.active{display:flex}',
		'@keyframes wqFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',

		// typography
		'.wq-title{font-size:clamp(1.1rem,4.5vw,1.6rem);font-weight:800;color:#fff;line-height:1.25;letter-spacing:-0.3px;text-shadow:0 2px 12px rgba(0,0,0,0.3);overflow-wrap:break-word;word-break:break-word}',
		'.wq-subtitle{font-size:14px;color:rgba(255,255,255,0.65);line-height:1.55}',

		// start btn
		'.wq-start-btn{padding:0 24px;height:52px;font-size:16px;font-weight:700;letter-spacing:0.4px;cursor:pointer;border:none;border-radius:14px;color:#fff;',
		'background:linear-gradient(135deg,#7c3aed 0%,#4705fb 100%);',
		'box-shadow:0 4px 22px rgba(71,5,251,0.5),inset 0 1px 0 rgba(255,255,255,0.15);',
		'transition:transform 0.15s,box-shadow 0.15s,filter 0.15s;position:relative;overflow:hidden;margin-top:6px}',
		'.wq-start-btn::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.1) 0%,transparent 60%);pointer-events:none}',
		'.wq-start-btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(71,5,251,0.65),inset 0 1px 0 rgba(255,255,255,0.15);filter:brightness(1.08)}',
		'.wq-start-btn:active{transform:translateY(0)}',

		// question
		'.wq-q-text{font-size:1rem;font-weight:700;color:#fff;line-height:1.4;overflow-wrap:break-word}',
		'.wq-options{display:flex;flex-direction:column;gap:9px}',
		'.wq-opt{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;',
		'border:1.5px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);',
		'transition:border-color 0.15s,background 0.15s,transform 0.1s;',
		'text-align:left;font-size:0.9rem;color:rgba(255,255,255,0.85);cursor:pointer;line-height:1.35}',
		'.wq-opt:hover{border-color:rgba(124,58,237,0.6);background:rgba(124,58,237,0.12);transform:translateX(2px)}',
		'.wq-opt.selected{border-color:#7c3aed;background:linear-gradient(135deg,rgba(124,58,237,0.35),rgba(71,5,251,0.25));color:#fff;box-shadow:0 2px 12px rgba(71,5,251,0.25)}',
		'.wq-opt-indicator{width:18px;height:18px;min-width:18px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);display:flex;align-items:center;justify-content:center;transition:border-color 0.15s,background 0.15s}',
		'.wq-opt.selected .wq-opt-indicator{border-color:#a78bfa;background:rgba(167,139,250,0.2)}',
		'.wq-opt.selected .wq-opt-indicator::after{content:"";display:block;width:8px;height:8px;border-radius:50%;background:#a78bfa}',
		'.wq-opt-checkbox .wq-opt-indicator{border-radius:5px}',
		'.wq-opt.selected .wq-opt-checkbox-indicator::after{content:"";display:block;width:10px;height:6px;border-left:2px solid #a78bfa;border-bottom:2px solid #a78bfa;transform:rotate(-45deg) translateY(-1px)}',

		// next btn
		'.wq-next-btn{align-self:flex-end;padding:10px 24px;border-radius:10px;border:none;',
		'background:linear-gradient(135deg,#7c3aed,#4705fb);color:#fff;',
		'font-size:0.9rem;font-weight:700;cursor:pointer;transition:opacity 0.2s,transform 0.15s;',
		'box-shadow:0 3px 12px rgba(71,5,251,0.4)}',
		'.wq-next-btn:hover{opacity:0.9;transform:translateY(-1px)}',
		'.wq-next-btn:disabled{opacity:0.35;cursor:default;transform:none}',

		// contact
		'.wq-contact-title{font-size:1rem;font-weight:700;color:#fff;line-height:1.35}',
		'.wq-input{border:1.5px solid rgba(255,255,255,0.1);outline:none;',
		'background:rgba(255,255,255,0.07);padding:0 15px;border-radius:12px;',
		'width:100%;color:#fff;font-size:15px;height:50px;',
		'transition:border-color 250ms,background 250ms,box-shadow 250ms;backdrop-filter:blur(4px)}',
		'.wq-input::placeholder{color:rgba(255,255,255,0.35)}',
		'.wq-input:focus{border-color:rgba(124,58,237,0.7);background:rgba(124,58,237,0.1);box-shadow:0 0 0 3px rgba(124,58,237,0.15)}',
		'.wq-input.error{border-color:rgba(239,68,68,0.7);box-shadow:0 0 0 3px rgba(239,68,68,0.12)}',

		'.wq-submit-btn{padding:0 24px;height:52px;font-size:16px;font-weight:700;letter-spacing:0.4px;cursor:pointer;border:none;border-radius:14px;color:#fff;',
		'background:linear-gradient(135deg,#7c3aed 0%,#4705fb 100%);',
		'box-shadow:0 4px 22px rgba(71,5,251,0.5),inset 0 1px 0 rgba(255,255,255,0.15);',
		'transition:transform 0.15s,box-shadow 0.15s,filter 0.15s;position:relative;overflow:hidden}',
		'.wq-submit-btn::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.1) 0%,transparent 60%);pointer-events:none}',
		'.wq-submit-btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(71,5,251,0.65);filter:brightness(1.08)}',
		'.wq-submit-btn:active{transform:translateY(0)}',
		'.wq-submit-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}',

		'.wq-privacy{font-size:12px;color:rgba(255,255,255,0.38);text-align:center;line-height:1.5}',
		'.wq-privacy a{color:rgba(255,255,255,0.55);text-decoration:underline;text-underline-offset:2px}',
		'.wq-privacy a:hover{color:#fff}',

		// result
		'.wq-result-badge{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,rgba(124,58,237,0.3),rgba(71,5,251,0.2));border:1px solid rgba(124,58,237,0.4);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:700;color:#a78bfa;letter-spacing:0.5px;text-transform:uppercase}',
		'.wq-result-title{font-size:clamp(1.1rem,4vw,1.5rem);font-weight:800;color:#fff;line-height:1.25;overflow-wrap:break-word}',
		'.wq-result-desc{font-size:0.9rem;color:rgba(255,255,255,0.72);line-height:1.65}',
		'.wq-promo{background:rgba(255,255,255,0.05);border:1px solid rgba(124,58,237,0.4);border-radius:14px;padding:16px 20px;text-align:center}',
		'.wq-promo-label{font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.8px;text-transform:uppercase;margin-bottom:6px}',
		'.wq-promo-code{font-size:1.4rem;font-weight:900;letter-spacing:0.1em;',
		'background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}',
		'.wq-result-btn{display:block;padding:13px 24px;border-radius:12px;border:none;',
		'background:linear-gradient(135deg,#7c3aed,#4705fb);color:#fff;',
		'font-size:0.95rem;font-weight:700;text-decoration:none;text-align:center;cursor:pointer;',
		'box-shadow:0 4px 18px rgba(71,5,251,0.45);transition:opacity 0.2s,transform 0.15s}',
		'.wq-result-btn:hover{opacity:0.9;transform:translateY(-1px)}',
		'.wq-divider{height:1px;background:rgba(255,255,255,0.08);margin:2px 0}',

		// already
		'.wq-already-icon{font-size:2.5rem;text-align:center}',
		'.wq-already-title{font-size:1.1rem;font-weight:700;color:#fff;text-align:center}',
		'.wq-already-desc{font-size:0.875rem;color:rgba(255,255,255,0.6);text-align:center;line-height:1.55}',

		// desktop
		'@media (min-width:768px){',
		'#wq-wrap{align-items:center}',
		'#wq-card{min-height:unset;padding:40px 40px 36px;justify-content:flex-start}',
		'}'
	].join('');

	shadow.appendChild(style);

	var container = document.createElement('div');
	container.innerHTML = [
		'<div id="wq-wrap">',
		'<div id="wq-overlay"></div>',
		'<div id="wq-card">',
		'<button id="wq-close" aria-label="Закрыть">',
		'<svg viewBox="0 0 24 24" fill="none"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
		'</button>',
		'<div id="wq-brand">Сделано в&nbsp;<a href="https://winwidget.ru" target="_blank" rel="noopener">winwidget.ru</a></div>',
		'<div id="wq-inner"></div>',
		'</div>',
		'</div>'
	].join('');
	shadow.appendChild(container);

	var wrap = shadow.getElementById('wq-wrap');
	var inner = shadow.getElementById('wq-inner');
	var closeBtn = shadow.getElementById('wq-close');
	var overlay = shadow.getElementById('wq-overlay');

	// ─── Validation helpers ───────────────────────────────────────────────────

	var EMAIL_REGEXP =
		/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

	// Phone mask (RU: +7 (9__) ___-__-__)
	function buildPhoneMask(region) {
		if (region === 'BY') return '+375 (__) ___-__-__';
		if (region === 'UA') return '+380 (__) ___-__-__';
		if (region === 'KZ') return '+7 (7__) ___-__-__';
		if (region === 'international') return '+__ (__________';
		return '+7 (9__) ___-__-__';
	}

	function maskDigitsCount(region) {
		if (region === 'BY') return 9;
		if (region === 'UA') return 9;
		if (region === 'KZ') return 9;
		if (region === 'international') return 7;
		return 9;
	}

	function shakeInput(el) {
		var distance = 6,
			shakes = 15,
			duration = 350,
			start = null;
		function frame(t) {
			if (!start) start = t;
			var p = (t - start) / duration;
			el.style.transform =
				'translateX(' +
				Math.sin(p * shakes * Math.PI * 2) * distance * (1 - p) +
				'px)';
			if (t - start < duration) requestAnimationFrame(frame);
			else {
				el.style.transform = '';
				el.classList.remove('error');
			}
		}
		el.classList.add('error');
		requestAnimationFrame(frame);
	}

	function esc(s) {
		return String(s || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	function hexToRgba(hex, alpha) {
		var h = String(hex || '#7c3aed').replace('#', '');
		if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
		var r = parseInt(h.slice(0, 2), 16),
			g = parseInt(h.slice(2, 4), 16),
			b = parseInt(h.slice(4, 6), 16);
		return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
	}

	// ─── Score calculation ────────────────────────────────────────────────────

	function scoreAnswers(answers, questions, results) {
		if (!results || !results.length) return null;
		var scores = {};
		results.forEach(function (r) {
			scores[r.id] = 0;
		});
		answers.forEach(function (ans) {
			var q = null;
			for (var i = 0; i < questions.length; i++) {
				if (questions[i].id === ans.questionId) {
					q = questions[i];
					break;
				}
			}
			if (!q) return;
			ans.optionIds.forEach(function (oid) {
				var opt = null;
				for (var j = 0; j < q.options.length; j++) {
					if (q.options[j].id === oid) {
						opt = q.options[j];
						break;
					}
				}
				if (!opt || !opt.scores) return;
				Object.keys(opt.scores).forEach(function (rid) {
					if (rid in scores) scores[rid] += Number(opt.scores[rid]) || 0;
				});
			});
		});
		var winner = results[0];
		var max = -Infinity;
		results.forEach(function (r) {
			if ((scores[r.id] || 0) > max) {
				max = scores[r.id] || 0;
				winner = r;
			}
		});
		return winner;
	}

	// ─── Widget init ──────────────────────────────────────────────────────────

	function initWidget(cfg) {
		var questions = cfg.questions || [];
		var results = cfg.results || [];
		var answers = [];

		_pulseEnabled = cfg.buttonPulse !== false;
		var _devMode = cfg.devModeActive === true;

		// Dynamic color overrides
		var _accent = cfg.color || '#7c3aed';
		var _btn = cfg.buttonColor || _accent;
		var dynStyle = document.createElement('style');
		dynStyle.textContent = [
			cfg.bgColor
				? '#wq-card{background:' + cfg.bgColor + '!important}'
				: '',
			'.wq-bar.done{background:' + _accent + '!important}',
			'.wq-start-btn,.wq-submit-btn,.wq-result-btn{background:' +
				_btn +
				'!important;box-shadow:0 4px 22px ' +
				hexToRgba(_btn, 0.5) +
				',inset 0 1px 0 rgba(255,255,255,0.15)!important}',
			'.wq-start-btn:hover,.wq-submit-btn:hover,.wq-result-btn:hover{box-shadow:0 8px 30px ' +
				hexToRgba(_btn, 0.65) +
				'!important}',
			'.wq-next-btn{background:' +
				_accent +
				'!important;box-shadow:0 3px 12px ' +
				hexToRgba(_accent, 0.4) +
				'!important}',
			'.wq-opt:hover{border-color:' +
				hexToRgba(_accent, 0.6) +
				'!important;background:' +
				hexToRgba(_accent, 0.12) +
				'!important}',
			'.wq-opt.selected{border-color:' +
				_accent +
				'!important;background:linear-gradient(135deg,' +
				hexToRgba(_accent, 0.35) +
				',' +
				hexToRgba(_btn, 0.25) +
				')!important;box-shadow:0 2px 12px ' +
				hexToRgba(_btn, 0.25) +
				'!important}',
			'.wq-input:focus{border-color:' +
				hexToRgba(_accent, 0.7) +
				'!important;box-shadow:0 0 0 3px ' +
				hexToRgba(_accent, 0.15) +
				'!important}',
			'.wq-result-badge{background:linear-gradient(135deg,' +
				hexToRgba(_accent, 0.3) +
				',' +
				hexToRgba(_btn, 0.2) +
				')!important;border-color:' +
				hexToRgba(_accent, 0.4) +
				'!important}'
		].join('');
		shadow.appendChild(dynStyle);

		// pixel events
		function firePixel(goal) {
			if (cfg.yandexMetrikaId && typeof ym === 'function') {
				try {
					ym(Number(cfg.yandexMetrikaId), 'reachGoal', goal);
				} catch (e) {}
			}
			if (cfg.vkPixelId && window.VK && typeof VK.Goal === 'function') {
				try {
					VK.Goal(goal);
				} catch (e) {}
			}
			if (cfg.roistatEnabled && window.roistat && window.roistat.event) {
				try {
					window.roistat.event.send(goal);
				} catch (e) {}
			}
		}

		function openWidget() {
			wrap.classList.remove('hidden');
			wrap.classList.add('visible');
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.width = '100%';
			quizBtn.style.opacity = '0';
			quizBtn.style.pointerEvents = 'none';
			quizBtn.style.transform = 'scale(0.8)';
			stopBtnAnim();
			firePixel('quiz_open');
		}

		function closeWidget() {
			wrap.classList.remove('visible');
			wrap.classList.add('hidden');
			document.body.style.overflow = '';
			document.body.style.position = '';
			document.body.style.width = '';
			if (!window.winquizAutoOpen) {
				quizBtn.style.opacity = '1';
				quizBtn.style.pointerEvents = 'auto';
				quizBtn.style.transform = 'scale(1)';
				startBtnAnim();
			}
		}

		quizBtn.addEventListener('click', openWidget);
		closeBtn.addEventListener('click', closeWidget);
		overlay.addEventListener('click', closeWidget);

		// ── Screens ────────────────────────────────────────────────────────────

		function makeProgress(current, total) {
			var el = document.createElement('div');
			el.id = 'wq-progress';
			for (var i = 0; i < total; i++) {
				var bar = document.createElement('div');
				bar.className = 'wq-bar' + (i < current ? ' done' : '');
				el.appendChild(bar);
			}
			return el;
		}

		function render(html) {
			inner.innerHTML = html;
		}

		function showWelcome() {
			answers = [];
			render(
				[
					'<div class="wq-screen active" id="s-welcome">',
					'<div class="wq-title">' + esc(cfg.title) + '</div>',
					cfg.subtitle
						? '<div class="wq-subtitle">' + esc(cfg.subtitle) + '</div>'
						: '',
					'<div class="wq-divider"></div>',
					'<button class="wq-start-btn" id="wq-start">' +
						esc(cfg.buttonText || 'Начать квиз') +
						'</button>',
					'</div>'
				].join('')
			);

			shadow
				.getElementById('wq-start')
				.addEventListener('click', function () {
					if (!questions.length) return;
					showQuestion(0);
				});
		}

		function showQuestion(idx) {
			if (idx >= questions.length) {
				var dc = (cfg.dataType || 'PHONE').toUpperCase();
				if (dc === 'NONE') {
					submitAndShowResult(null, null);
				} else {
					showContact();
				}
				return;
			}
			var q = questions[idx];
			var isCheckbox = q.type === 'checkbox';
			var selected = [];

			inner.innerHTML = '';
			inner.appendChild(makeProgress(idx, questions.length));

			var screen = document.createElement('div');
			screen.className = 'wq-screen active';

			var counter = document.createElement('div');
			counter.style.cssText =
				'font-size:12px;font-weight:600;color:rgba(255,255,255,0.4);letter-spacing:0.5px;text-transform:uppercase';
			counter.textContent =
				'Вопрос ' + (idx + 1) + ' из ' + questions.length;
			screen.appendChild(counter);

			var qText = document.createElement('div');
			qText.className = 'wq-q-text';
			qText.textContent = q.text || 'Вопрос ' + (idx + 1);
			screen.appendChild(qText);

			var optList = document.createElement('div');
			optList.className = 'wq-options';
			var goNextScheduled = false;

			q.options.forEach(function (opt, oIdx) {
				var btn = document.createElement('button');
				btn.className = 'wq-opt' + (isCheckbox ? ' wq-opt-checkbox' : '');
				btn.setAttribute('data-id', opt.id);
				btn.innerHTML = [
					'<span class="wq-opt-indicator' +
						(isCheckbox ? ' wq-opt-checkbox-indicator' : '') +
						'"></span>',
					'<span>' + esc(opt.text || 'Вариант ' + (oIdx + 1)) + '</span>'
				].join('');

				btn.addEventListener('click', function () {
					if (isCheckbox) {
						var i = selected.indexOf(opt.id);
						if (i === -1) {
							selected.push(opt.id);
							btn.classList.add('selected');
						} else {
							selected.splice(i, 1);
							btn.classList.remove('selected');
						}
						if (nextBtn) nextBtn.disabled = selected.length === 0;
					} else {
						selected = [opt.id];
						optList.querySelectorAll('.wq-opt').forEach(function (b) {
							b.classList.remove('selected');
						});
						btn.classList.add('selected');
						if (!goNextScheduled) {
							goNextScheduled = true;
							setTimeout(goNext, 300);
						}
					}
				});
				optList.appendChild(btn);
			});
			screen.appendChild(optList);

			var nextBtn = null;
			if (isCheckbox) {
				nextBtn = document.createElement('button');
				nextBtn.className = 'wq-next-btn';
				nextBtn.textContent = 'Далее →';
				nextBtn.disabled = true;
				nextBtn.addEventListener('click', goNext);
				screen.appendChild(nextBtn);
			}

			inner.appendChild(screen);

			function goNext() {
				answers.push({ questionId: q.id, optionIds: selected.slice() });
				showQuestion(idx + 1);
			}
		}

		function showContact() {
			var dc = (cfg.dataType || 'PHONE').toUpperCase();
			var region = cfg.phoneRegion || 'RU';
			var MASK = buildPhoneMask(region);
			var NEED_DIGITS = maskDigitsCount(region);
			var phoneDigits = '';

			render(
				[
					'<div class="wq-screen active" id="s-contact">',
					'<div class="wq-contact-title">' +
						esc(
							cfg.contactTitle ||
								'Оставьте контакт для получения результата'
						) +
						'</div>',
					dc === 'PHONE' || dc === 'PHONE_AND_EMAIL'
						? '<input class="wq-input" id="wq-phone" type="tel" placeholder="✦  Ваш телефон" autocomplete="tel"/>'
						: '',
					dc === 'EMAIL' || dc === 'PHONE_AND_EMAIL'
						? '<input class="wq-input" id="wq-email" type="email" placeholder="✦  Ваш email" autocomplete="email"/>'
						: '',
					'<div id="wq-err" style="font-size:13px;color:rgba(239,120,100,1);min-height:18px"></div>',
					'<button class="wq-submit-btn" id="wq-submit">Получить результат</button>',
					cfg.privacyUrl
						? '<div class="wq-privacy">Нажимая кнопку, вы соглашаетесь с <a href="' +
							esc(cfg.privacyUrl) +
							'" target="_blank" rel="noopener">политикой конфиденциальности</a></div>'
						: '',
					'</div>'
				].join('')
			);

			var phoneInput = shadow.getElementById('wq-phone');
			var emailInput = shadow.getElementById('wq-email');
			var errEl = shadow.getElementById('wq-err');
			var submitBtn = shadow.getElementById('wq-submit');

			// Phone mask (RU style from wheel.js)
			if (phoneInput) {
				function renderMask() {
					var res = MASK.split('');
					var d = 0;
					for (var i = 0; i < res.length; i++) {
						if (res[i] === '_' && phoneDigits[d]) {
							res[i] = phoneDigits[d++];
						}
					}
					phoneInput.value = res.join('');
					var pos = phoneInput.value.indexOf('_');
					phoneInput.setSelectionRange(
						pos === -1 ? phoneInput.value.length : pos,
						pos === -1 ? phoneInput.value.length : pos
					);
				}

				phoneInput.addEventListener('focus', function () {
					if (!phoneInput.value) renderMask();
				});
				phoneInput.addEventListener('blur', function () {
					if (!phoneDigits.length) phoneInput.value = '';
				});

				phoneInput.addEventListener('keydown', function (e) {
					if (/\d/.test(e.key)) {
						if (phoneDigits.length < NEED_DIGITS) {
							phoneDigits += e.key;
							renderMask();
						}
						e.preventDefault();
						return;
					}
					if (e.key === 'Backspace') {
						phoneDigits = phoneDigits.slice(0, -1);
						renderMask();
						e.preventDefault();
						return;
					}
					if (!['ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key))
						e.preventDefault();
				});

				phoneInput.addEventListener('paste', function (e) {
					e.preventDefault();
					var text = (e.clipboardData || window.clipboardData).getData(
						'text'
					);
					var digitsOnly = text.replace(/\D/g, '');
					var stripped = digitsOnly.replace(/^[78]?9?/, '');
					phoneDigits = stripped.slice(0, NEED_DIGITS);
					renderMask();
				});
			}

			function getPhone() {
				if (!phoneInput) return null;
				if (region === 'RU' || region === 'KZ')
					return phoneDigits.length === NEED_DIGITS
						? '79' + phoneDigits
						: null;
				if (region === 'BY')
					return phoneDigits.length === NEED_DIGITS
						? '375' + phoneDigits
						: null;
				if (region === 'UA')
					return phoneDigits.length === NEED_DIGITS
						? '380' + phoneDigits
						: null;
				return phoneDigits.length >= 7 ? phoneDigits : null;
			}

			submitBtn.addEventListener('click', function () {
				errEl.textContent = '';
				var valid = true;

				if (!_devMode) {
					if (phoneInput && phoneDigits.length !== NEED_DIGITS) {
						shakeInput(phoneInput);
						errEl.textContent = 'Введите корректный номер телефона';
						valid = false;
					}
					if (
						valid &&
						emailInput &&
						!EMAIL_REGEXP.test(emailInput.value.trim())
					) {
						shakeInput(emailInput);
						errEl.textContent = 'Введите корректный email';
						valid = false;
					}
					if (!valid) return;
				}

				submitBtn.disabled = true;
				submitBtn.textContent = 'Отправляем...';
				submitAndShowResult(
					getPhone(),
					emailInput ? emailInput.value.trim() : null
				);
			});
		}

		function setPlayedCookie() {
			try {
				var ck = 'wq_p_' + KEY + '_' + (cfg.quizResetToken || '');
				var d =
					(cfg.quizCooldownDays || 0) > 0 ? cfg.quizCooldownDays : 365;
				document.cookie =
					ck +
					'=' +
					encodeURIComponent(String(Date.now())) +
					';expires=' +
					new Date(Date.now() + d * 864e5).toUTCString() +
					';path=/;SameSite=Lax';
			} catch (e) {}
		}

		function submitAndShowResult(phone, email) {
			var resultData = scoreAnswers(answers, questions, results);
			setPlayedCookie();

			fetch(API_BASE + '/quiz/' + KEY + '/lead', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contact: phone || email || 'unknown',
					phone: phone || undefined,
					email: email || undefined,
					answers: answers,
					url: window.location.href
				})
			}).catch(function () {});

			firePixel('quiz_lead');
			showResult(resultData);
		}

		function showResult(rd) {
			render(
				[
					'<div class="wq-screen active" id="s-result">',
					'<div class="wq-result-badge">&#10003; Ваш результат</div>',
					rd
						? [
								'<div class="wq-result-title">' + esc(rd.title) + '</div>',
								rd.description
									? '<div class="wq-result-desc">' +
										esc(rd.description) +
										'</div>'
									: '',
								rd.promoCode
									? [
											'<div class="wq-promo">',
											'<div class="wq-promo-label">Ваш промокод</div>',
											'<div class="wq-promo-code">' +
												esc(rd.promoCode) +
												'</div>',
											'</div>'
										].join('')
									: '',
								rd.buttonText && rd.buttonUrl
									? '<a class="wq-result-btn" href="' +
										esc(rd.buttonUrl) +
										'" target="_blank" rel="noopener noreferrer">' +
										esc(rd.buttonText) +
										'</a>'
									: ''
							].join('')
						: [
								'<div class="wq-result-title">Спасибо!</div>',
								'<div class="wq-result-desc">Ваши ответы приняты. Мы свяжемся с вами в ближайшее время.</div>'
							].join(''),
					'</div>'
				].join('')
			);
		}

		function showAlready() {
			render(
				[
					'<div class="wq-screen active">',
					'<div class="wq-already-icon">🎉</div>',
					'<div class="wq-already-title">' +
						esc(cfg.alreadyPlayedTitle || 'Вы уже проходили этот квиз!') +
						'</div>',
					'<div class="wq-already-desc">' +
						esc(
							cfg.alreadyPlayedSubtitle ||
								'Каждый посетитель может пройти квиз только один раз'
						) +
						'</div>',
					'</div>'
				].join('')
			);
		}

		// ── Button positioning ─────────────────────────────────────────────────

		var qsz = cfg.buttonSize ?? 60;
		var btnSvg = quizBtn.querySelector('#wq-btn-svg');
		if (btnSvg) {
			btnSvg.setAttribute('width', qsz + '');
			btnSvg.setAttribute('height', qsz + '');
		}
		var qLabelEl = quizBtn.querySelector('#wq-btn-label');
		if (qLabelEl) {
			var qlf = Math.max(8, Math.round((qsz / 60) * 11));
			var qlph = Math.max(2, Math.round((qsz / 60) * 3));
			var qlpv = Math.max(6, Math.round((qsz / 60) * 12));
			qLabelEl.style.fontSize = qlf + 'px';
			qLabelEl.style.padding = qlph + 'px ' + qlpv + 'px';
		}
		var _openBtnColor = cfg.openButtonColor || _accent;
		var gradEl = quizBtn.querySelector('#wqGrad');
		if (gradEl) {
			var stops = gradEl.querySelectorAll('stop');
			if (stops[0]) stops[0].setAttribute('stop-color', _openBtnColor);
			if (stops[1]) stops[1].setAttribute('stop-color', _openBtnColor);
		}
		var iconEl = quizBtn.querySelector('#wq-btn-icon');
		if (iconEl) {
			iconEl.style.filter =
				'drop-shadow(0 6px 20px ' +
				hexToRgba(_openBtnColor, 0.55) +
				') drop-shadow(0 2px 6px rgba(0,0,0,0.3))';
		}
		var qBtnLabel = quizBtn.querySelector('#wq-btn-label');
		if (qBtnLabel) {
			qBtnLabel.style.background =
				'linear-gradient(135deg,' +
				_openBtnColor +
				',' +
				_openBtnColor +
				')';
			qBtnLabel.style.boxShadow =
				'0 3px 12px ' + hexToRgba(_openBtnColor, 0.5);
		}

		quizBtn.style.bottom = (cfg.buttonBottom ?? 3) + '%';
		if (cfg.buttonSide === 'left') {
			quizBtn.style.right = 'auto';
			quizBtn.style.left = (cfg.buttonOffset ?? 3) + '%';
		} else {
			quizBtn.style.left = 'auto';
			quizBtn.style.right = (cfg.buttonOffset ?? 3) + '%';
		}

		// ── Already played check ──────────────────────────────────────────────

		var hasPlayed = false;
		try {
			var cookieKey = 'wq_p_' + KEY + '_' + (cfg.quizResetToken || '');
			var stored = document.cookie.match(
				'(?:^|;)\\s*' + cookieKey + '=([^;]*)'
			);
			if (stored) {
				var ts = decodeURIComponent(stored[1]);
				var cooldownMs = (cfg.quizCooldownDays || 0) * 864e5;
				if (cooldownMs === 0) {
					hasPlayed = true;
				} else {
					hasPlayed = Date.now() - parseInt(ts, 10) < cooldownMs;
				}
			}
		} catch (e) {}

		// Server-side IP check takes priority
		if (cfg.hasPlayedByIp) hasPlayed = true;

		if (hasPlayed && cfg.hideIfPlayed) {
			quizBtn.style.display = 'none';
			return;
		}

		if (cfg.autoOpenDelay && !hasPlayed)
			setTimeout(openWidget, cfg.autoOpenDelay * 1000);

		if (window.winquizAutoOpen) {
			closeBtn.style.display = 'none';
			overlay.style.pointerEvents = 'none';
			setTimeout(openWidget, 300);
			if (hasPlayed) {
				setTimeout(showAlready, 350);
			} else {
				showWelcome();
			}
		} else {
			if (hasPlayed) {
				showAlready();
			} else {
				showWelcome();
			}
			quizBtn.style.display = 'flex';
			stopBtnAnim();
			startBtnAnim();
		}
	}

	// ─── Boot ─────────────────────────────────────────────────────────────────

	function showDisabledPage() {
		var el = document.createElement('div');
		el.style.cssText =
			'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d0d1a;color:#fff;font-family:sans-serif;text-align:center;padding:24px;z-index:2147483647';
		el.innerHTML =
			'<div style="font-size:3rem;margin-bottom:16px">🔒</div><h1 style="font-size:1.3rem;font-weight:700;margin-bottom:10px">Квиз отключён</h1><p style="font-size:0.9rem;color:#8080a0;margin-bottom:28px;max-width:300px">Этот квиз в данный момент отключён.</p><a href="https://winwidget.ru/widgets" style="display:inline-block;padding:11px 28px;background:#4705fb;color:#fff;border-radius:10px;font-weight:700;font-size:0.9rem;text-decoration:none">Перейти в кабинет</a>';
		document.body.appendChild(el);
	}

	fetch(API_BASE + '/quiz/' + KEY + '/config')
		.then(function (r) {
			return r.json();
		})
		.then(function (server) {
			if (!server || !server.isActive) {
				if (window.winquizAutoOpen) showDisabledPage();
				return;
			}
			initWidget(server);
		})
		.catch(function (e) {
			console.error('[winquiz] failed to load config', e);
		});
})();
