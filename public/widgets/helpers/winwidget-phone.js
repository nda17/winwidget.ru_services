(function () {
	'use strict';
	if (window.winwidgetPhone) return;
	var o = document.currentScript,
		d = (function () {
			try {
				var e = new URL(o && o.src ? o.src : location.href);
				return (
					(e.pathname = e.pathname.replace(/\/[^/]*$/, '/')),
					(e.search = ''),
					(e.hash = ''),
					e.toString()
				);
			} catch (n) {
				return 'https://winwidget.ru/widgets/';
			}
		})(),
		u = null;
	function f(e) {
		return new Promise(function (n, r) {
			var t = document.querySelector('script[src="' + e + '"]');
			if (t) {
				(t.addEventListener('load', n, { once: !0 }),
					t.addEventListener('error', r, { once: !0 }),
					window.libphonenumber && n());
				return;
			}
			var i = document.createElement('script');
			((i.src = e),
				(i.async = !0),
				(i.onload = n),
				(i.onerror = r),
				document.head.appendChild(i));
		});
	}
	function h() {
		return window.libphonenumber
			? Promise.resolve(window.libphonenumber)
			: (u ||
					(u = f(d + 'libphonenumber-min.js').then(function () {
						if (!window.libphonenumber)
							throw new Error('libphonenumber-js is not available');
						return window.libphonenumber;
					})),
				u);
	}
	function l(e) {
		var n = String(e || '').trim(),
			r = n.replace(/\D/g, '');
		return n.indexOf('+') === 0
			? n
			: n.indexOf('8') === 0 && r.length >= 10
				? '7' + r.slice(1)
				: n;
	}
	function c(e) {
		var n = window.libphonenumber,
			r = l(e);
		if (!n || !r) return r;
		try {
			var t =
				r.indexOf('+') === 0 ? new n.AsYouType() : new n.AsYouType('RU');
			return t.input(r);
		} catch (i) {
			return r;
		}
	}
	function a(e) {
		var n = window.libphonenumber,
			r = l(e);
		if (!n || !r) return null;
		try {
			var t = n.parsePhoneNumberFromString(
				r,
				r.indexOf('+') === 0 ? void 0 : 'RU'
			);
			return t && t.isValid() ? t.number : null;
		} catch (i) {
			return null;
		}
	}
	function w(e, n) {
		if (((n = n || {}), !e)) return null;
		((e.placeholder = n.placeholder || '+7 999 123-45-67'),
			e.setAttribute('inputmode', 'tel'),
			e.setAttribute('autocomplete', 'tel'));
		function r() {
			var t = e.selectionStart === e.value.length;
			if (((e.value = c(e.value)), t))
				try {
					e.setSelectionRange(e.value.length, e.value.length);
				} catch (i) {}
			typeof n.onChange == 'function' && n.onChange(a(e.value));
		}
		return (
			e.addEventListener('input', r),
			e.addEventListener('paste', function () {
				setTimeout(r, 0);
			}),
			{
				getNumber: function () {
					return a(e.value);
				},
				isValid: function () {
					return !!a(e.value);
				},
				format: r,
				destroy: function () {
					e.removeEventListener('input', r);
				}
			}
		);
	}
	window.winwidgetPhone = { load: h, format: c, parse: a, attach: w };
})();
