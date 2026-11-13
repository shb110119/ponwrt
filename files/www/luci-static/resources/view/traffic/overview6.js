'use strict';
'require view';
'require poll';
'require rpc';

var callGetRate = rpc.declare({
	object: 'luci.traffic',
	method: 'get_rate'
});

var callGetHistory = rpc.declare({
	object: 'luci.traffic',
	method: 'get_history',
	params: [ 'iface', 'range', 'key' ]
});

var IFACE_LABEL = {
	'pppoe-wan': 'WAN (PPPoE)',
	'br-lan': 'LAN 桥接',
	'pon0': 'PON 光口',
	'pon0.140': 'PON VLAN 140',
	'phy0-ap0': '无线 2.4G',
	'phy1-ap0': '无线 5G',
	'eth0': 'eth0',
	'lan1': 'LAN1'
};

/* 无线接口优先按实测频率命名，静态表只作兜底（不同机型 phy 顺序可能不同） */
function labelFor(name, rec) {
	if (rec && rec.band)
		return '无线 ' + rec.band;

	return IFACE_LABEL[name] || name;
}

/* 这些接口的 rx 是「客户端上传」，需要与 WAN 视角对调 */
var FLIP = { 'br-lan': 1, 'phy0-ap0': 1, 'phy1-ap0': 1, 'lan1': 1 };

var COL_DOWN = '#ff9800';
var COL_UP = '#2196f3';
var CAP_MS = 900000;

var TABS = [
	[ 'rt', '实时' ],
	[ '24h', '最近 24 小时' ],
	[ 'day', '按天' ],
	[ 'month', '按月' ]
];

function pad(n) {
	return n < 10 ? '0' + n : '' + n;
}

function fmtRate(bps) {
	bps = +bps || 0;
	if (!isFinite(bps) || bps < 0) bps = 0;
	var u = [ 'bps', 'Kbps', 'Mbps', 'Gbps' ], i = 0;
	while (bps >= 1000 && i < 3) { bps /= 1000; i++; }
	return (i === 0 ? bps.toFixed(0) : bps.toFixed(2)) + ' ' + u[i];
}

function fmtBytes(b) {
	b = +b || 0;
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], i = 0;
	while (b >= 1024 && i < 4) { b /= 1024; i++; }
	return (i === 0 ? b.toFixed(0) : b.toFixed(2)) + ' ' + u[i];
}

function niceMax(v) {
	if (!(v > 0)) return 1000;
	var exp = Math.floor(Math.log(v) / Math.LN10);
	var base = Math.pow(10, exp);
	var m = v / base;
	var n = (m <= 1) ? 1 : (m <= 2) ? 2 : (m <= 5) ? 5 : 10;
	return n * base;
}

function dayStart(key) {
	var p = (key || '').split('-');
	if (p.length !== 3) return 0;
	return Math.floor(new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0).getTime() / 1000);
}

function monthRange(key) {
	var p = (key || '').split('-');
	if (p.length !== 2) return { t0: 0, t1: 0 };
	var y = +p[0], m = +p[1];
	var t0 = Math.floor(new Date(y, m - 1, 1, 0, 0, 0).getTime() / 1000);
	var t1 = Math.floor(new Date(y, m, 1, 0, 0, 0).getTime() / 1000);
	return { t0: t0, t1: t1 };
}

function hhmm(ts) { var d = new Date(ts * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function hh00(ts) { var d = new Date(ts * 1000); return pad(d.getHours()) + ':00'; }
function mmdd(ts) { var d = new Date(ts * 1000); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

return view.extend({
	load: function() {
		return callGetRate();
	},

	render: function(res) {
		var ifaces = Object.keys((res && res.ifaces) || {});

		if (!ifaces.length)
			return E('div', { 'class': 'cbi-section' }, E('p', {}, '读取不到接口计数器（/sys/class/net）。'));

		var state = {
			tab: 'rt',
			iface: ifaces.indexOf('pppoe-wan') >= 0 ? 'pppoe-wan' : ifaces[0],
			win: 60,
			samples: [],
			last: null,
			totals: {},
			hist: null,
			rows: [],
			histKey: '',
			histLoading: false,
			tickCount: 0
		};

		var canvas = E('canvas', {
			style: 'width:100%;height:280px;display:block'
		});

		var chartBox = E('div', {
			style: 'border:1px solid rgba(128,128,128,0.25);border-radius:6px;padding:6px;margin-bottom:14px'
		}, canvas);

		var tds = {}, tabBtns = {}, winBtns = [], hintEl,
			sumTable, histBox, histTbody, histEmpty, histHead;

		function mkRow(key, label, color) {
			var cur = E('td', {}, '-'), avg = E('td', {}, '-'), mx = E('td', {}, '-'), tot = E('td', {}, '-');
			tds[key] = { cur: cur, avg: avg, max: mx, tot: tot };
			return E('tr', {}, [
				E('td', { style: 'width:40px' },
					E('span', { style: 'display:inline-block;width:24px;height:12px;border-radius:2px;background:' + color })),
				E('td', {}, label),
				cur, avg, mx, tot
			]);
		}

		/* ---------- 绘图 ---------- */

		function prepCanvas() {
			var w = canvas.clientWidth || 600, h = 280;
			var dpr = window.devicePixelRatio || 1;

			if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
				canvas.width = Math.round(w * dpr);
				canvas.height = Math.round(h * dpr);
			}

			var g = canvas.getContext('2d');
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.clearRect(0, 0, w, h);

			return { g: g, w: w, h: h };
		}

		function gridAndAxis(g, w, h, ymax, xlabels) {
			var padL = 72, padR = 16, padT = 14, padB = 30;
			var pw = w - padL - padR, ph = h - padT - padB;

			g.lineWidth = 1;
			g.font = '11px sans-serif';
			g.textBaseline = 'middle';

			for (var i = 0; i <= 4; i++) {
				var y = padT + ph - (i / 4) * ph;
				g.strokeStyle = 'rgba(128,128,128,0.22)';
				g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + pw, y); g.stroke();
				g.fillStyle = 'rgba(128,128,128,1)';
				g.textAlign = 'right';
				g.fillText(fmtRate(ymax * i / 4), padL - 8, y);
			}

			g.textAlign = 'center';
			g.textBaseline = 'top';
			for (var j = 0; j < xlabels.length; j++)
				g.fillText(xlabels[j].text, padL + xlabels[j].frac * pw, padT + ph + 8);

			return { padL: padL, padR: padR, padT: padT, padB: padB, pw: pw, ph: ph };
		}

		function drawRt() {
			var c = prepCanvas(), g = c.g;
			var now = Date.now(), span = state.win * 1000;
			var pts = state.samples.filter(function(s) { return s.t >= now - span; });

			var ymax = 0;
			pts.forEach(function(s) { ymax = Math.max(ymax, s.down, s.up); });

			var labels = [];
			for (var j = 0; j <= 4; j++) {
				var secs = -(span / 1000) * (1 - j / 4);
				labels.push({ frac: j / 4, text: secs === 0 ? 'now' : Math.round(secs) + 's' });
			}

			var ax = gridAndAxis(g, c.w, c.h, niceMax(ymax), labels);
			if (ax.pw < 20) return;

			function line(key, color) {
				if (pts.length < 2) return;
				g.beginPath();
				g.strokeStyle = color;
				g.lineWidth = 2;
				g.lineJoin = 'round';
				pts.forEach(function(s, idx) {
					var x = ax.padL + ax.pw - ((now - s.t) / span) * ax.pw;
					var y = ax.padT + ax.ph - (Math.min(s[key], ymax || 1) / (ymax || 1)) * ax.ph;
					idx ? g.lineTo(x, y) : g.moveTo(x, y);
				});
				g.stroke();
			}

			line('down', COL_DOWN);
			line('up', COL_UP);
		}

		function drawHist() {
			var c = prepCanvas(), g = c.g;

			if (!state.hist || !state.hist.ok) {
				g.fillStyle = 'rgba(128,128,128,1)';
				g.font = '13px sans-serif';
				g.textAlign = 'center';
				g.textBaseline = 'middle';
				g.fillText(state.histLoading ? '加载中…' :
					(state.hist && state.hist.error === 'nodb' ? '该接口未纳入 vnstat 统计' : '暂无数据'), c.w / 2, c.h / 2);
				return;
			}

			var h = state.hist, t0 = h.t0, t1 = h.t1, interval = h.interval || 300;
			var flip = FLIP[state.iface];

			if (!(t1 > t0)) {
				t1 = Math.floor(Date.now() / 1000);
				t0 = t1 - (state.tab === 'month' ? 31 * 86400 : (state.tab === 'day' ? 86400 : 86400));
			}

			var pts = (h.points || []).map(function(p) {
				var rx = +p.rx || 0, tx = +p.tx || 0;
				return {
					t: p.timestamp + interval / 2,
					down: (flip ? tx : rx) * 8 / interval,
					up: (flip ? rx : tx) * 8 / interval
				};
			}).filter(function(p) { return p.t >= t0 - 1 && p.t <= t1 + 1; });

			var ymax = 0;
			pts.forEach(function(p) { ymax = Math.max(ymax, p.down, p.up); });

			var lab = state.tab === '24h' ? hhmm : (state.tab === 'day' ? hh00 : mmdd);
			var labels = [];
			for (var j = 0; j <= 5; j++)
				labels.push({ frac: j / 5, text: lab(t0 + (t1 - t0) * j / 5) });

			/* 无数据区间用浅灰底标出，避免"看起来有数据但其实是空白" */
			{
				var pL = 72, pR = 16, pT = 14, pB = 30;
				var gpw = c.w - pL - pR, gph = c.h - pT - pB;

				if (gpw > 10) {
					g.fillStyle = 'rgba(128,128,128,0.07)';

					if (!pts.length) {
						g.fillRect(pL, pT, gpw, gph);
					}
					else {
						var xFirst = pL + ((pts[0].t - t0) / (t1 - t0)) * gpw;
						var xLast = pL + ((pts[pts.length - 1].t - t0) / (t1 - t0)) * gpw;

						if (xFirst > pL + 0.5)
							g.fillRect(pL, pT, xFirst - pL, gph);

						if (xLast < pL + gpw - 0.5)
							g.fillRect(xLast, pT, pL + gpw - xLast, gph);
					}
				}
			}

			var ax = gridAndAxis(g, c.w, c.h, niceMax(ymax), labels);
			if (ax.pw < 20) return;

			if (!pts.length) {
				g.fillStyle = 'rgba(128,128,128,1)';
				g.font = '13px sans-serif';
				g.textAlign = 'center';
				g.textBaseline = 'middle';
				g.fillText('该时段暂无数据（vnstat 刚开始记录）', c.w / 2, c.h / 2);
				return;
			}

			function line(key, color) {
				g.beginPath();
				g.strokeStyle = color;
				g.fillStyle = color;
				g.lineWidth = 2;
				g.lineJoin = 'round';
				pts.forEach(function(p, idx) {
					var x = ax.padL + ((p.t - t0) / (t1 - t0)) * ax.pw;
					var y = ax.padT + ax.ph - (p[key] / (ymax || 1)) * ax.ph;
					idx ? g.lineTo(x, y) : g.moveTo(x, y);
				});
				g.stroke();

				if (pts.length <= 40) {
					pts.forEach(function(p) {
						var x0 = ax.padL + ((p.t - t0) / (t1 - t0)) * ax.pw;
						var y0 = ax.padT + ax.ph - (p[key] / (ymax || 1)) * ax.ph;
						g.beginPath();
						g.arc(x0, y0, 2.5, 0, Math.PI * 2);
						g.fill();
					});
				}
			}

			line('down', COL_DOWN);
			line('up', COL_UP);

			/* 数据只覆盖窗口一小段时，居中说明，避免误以为图坏了 */
			var cov = (pts[pts.length - 1].t - pts[0].t) / (t1 - t0);

			if (cov < 0.25) {
				var f = new Date((pts[0].t - interval / 2) * 1000);
				var mins = Math.round((pts[pts.length - 1].t - pts[0].t + interval) / 60);

				g.fillStyle = 'rgba(128,128,128,1)';
				g.font = '13px sans-serif';
				g.textAlign = 'center';
				g.textBaseline = 'middle';
				g.fillText('仅采集到 ' + pad(f.getMonth() + 1) + '-' + pad(f.getDate()) + ' ' +
					pad(f.getHours()) + ':' + pad(f.getMinutes()) + ' 之后的数据（共 ' + mins + ' 分钟）',
					ax.padL + ax.pw / 2, ax.padT + ax.ph / 2);
			}
		}

		function draw() {
			if (state.tab === 'rt') drawRt();
			else if (state.tab === '24h') drawHist();
		}

		/* ---------- 表格 ---------- */

		function setTd(c, cur, avg, mx, tot) {
			c.cur.textContent = cur;
			c.avg.textContent = avg;
			c.max.textContent = mx;
			c.tot.textContent = tot;
		}

		function refreshTableRt() {
			var now = Date.now();
			var pts = state.samples.filter(function(s) { return s.t >= now - state.win * 1000; });
			var tot = state.totals[state.iface] || { rx: 0, tx: 0 };
			var flip = FLIP[state.iface];

			[ [ 'down', flip ? tot.tx : tot.rx ],
			  [ 'up', flip ? tot.rx : tot.tx ] ].forEach(function(it) {
				var key = it[0], c = tds[key];
				if (!c) return;

				if (!pts.length) {
					setTd(c, '-', '-', '-', fmtBytes(it[1]));
				}
				else {
					var cur = pts[pts.length - 1][key], sum = 0, mx = 0;
					pts.forEach(function(s) { sum += s[key]; if (s[key] > mx) mx = s[key]; });
					setTd(c, fmtRate(cur), fmtRate(sum / pts.length), fmtRate(mx), fmtBytes(it[1]));
				}
			});
		}

		function refreshTableHist() {
			var h = state.hist;

			if (!h || !h.ok) {
				[ 'down', 'up' ].forEach(function(k) { if (tds[k]) setTd(tds[k], '-', '-', '-', '-'); });
				return;
			}

			var interval = h.interval || 300;
			var flip = FLIP[state.iface];
			var pts = h.points || [];

			if (!pts.length) {
				[ 'down', 'up' ].forEach(function(k) { if (tds[k]) setTd(tds[k], '-', '-', '-', '-'); });
				return;
			}

			var firstT = pts[0].timestamp, lastT = pts[pts.length - 1].timestamp;
			var covered = Math.max(lastT + interval - firstT, interval);

			var sumDown = 0, sumUp = 0, maxDown = 0, maxUp = 0;

			pts.forEach(function(p) {
				var rx = (+p.rx || 0) * 8 / interval;
				var tx = (+p.tx || 0) * 8 / interval;
				var down = flip ? tx : rx;
				var up = flip ? rx : tx;

				sumDown += down * interval / 8;
				sumUp += up * interval / 8;
				if (down > maxDown) maxDown = down;
				if (up > maxUp) maxUp = up;
			});

			var last = pts[pts.length - 1];
			var lastDown = (flip ? (+last.tx || 0) : (+last.rx || 0)) * 8 / interval;
			var lastUp = (flip ? (+last.rx || 0) : (+last.tx || 0)) * 8 / interval;

			setTd(tds.down, fmtRate(lastDown), fmtRate(sumDown * 8 / covered), fmtRate(maxDown), fmtBytes(sumDown));
			setTd(tds.up, fmtRate(lastUp), fmtRate(sumUp * 8 / covered), fmtRate(maxUp), fmtBytes(sumUp));
		}

		/* 日/月列表：一行一天（或一月），只给数值，不画图 */
		function refreshListTable() {
			if (!histTbody) return;

			while (histTbody.firstChild)
				histTbody.removeChild(histTbody.firstChild);

			var rows = state.rows || [];

			if (!rows.length) {
				histEmpty.textContent = '该时段没有数据';
				histEmpty.style.display = '';
				return;
			}

			histEmpty.style.display = 'none';
			if (histHead) histHead.textContent = state.tab === 'month' ? '月份' : '日期';

			var flip = FLIP[state.iface];

			rows.forEach(function(r) {
				var rx = +r.rx || 0, tx = +r.tx || 0;
				var down = flip ? tx : rx, up = flip ? rx : tx;

				histTbody.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, r.key),
					E('td', { 'class': 'td' }, fmtBytes(down)),
					E('td', { 'class': 'td' }, fmtBytes(up)),
					E('td', { 'class': 'td' }, fmtBytes(down + up))
				]));
			});
		}

		function refreshTable() {
			if (state.tab === 'rt') refreshTableRt();
			else if (state.tab === 'day' || state.tab === 'month') refreshListTable();
			else refreshTableHist();
		}

		/* ---------- 数据加载 ---------- */

		function syncLayout() {
			var isList = (state.tab === 'day' || state.tab === 'month');

			if (chartBox) chartBox.style.display = isList ? 'none' : '';
			if (sumTable) sumTable.style.display = isList ? 'none' : '';
			if (histBox) histBox.style.display = isList ? '' : 'none';
			if (winBox) winBox.style.display = state.tab === 'rt' ? '' : 'none';
		}

		function loadHistory() {
			if (state.tab === 'rt') return Promise.resolve();

			state.histLoading = true;
			if (state.tab === '24h') draw();
			else if (histEmpty) histEmpty.textContent = '加载中…';

			var range = state.tab;

			return callGetHistory(state.iface, range, '').then(function(r) {
				state.histLoading = false;

				if (!r || !r.ok) {
					state.hist = r || { ok: false, error: 'nodb' };
					state.rows = [];
					syncLayout();
					draw();
					refreshTable();
					hintEl.textContent = (r && r.error === 'nodb')
						? '该接口还没有历史数据，先用「实时」页看；历史统计需要 vnstat 采集一段时间后才有。'
						: '读取历史数据失败。';
					return;
				}

				if (range === 'day' || range === 'month') {
					state.hist = r;
					state.rows = r.rows || [];
					syncLayout();
					refreshTable();
					hintEl.textContent = (range === 'day' ? '按天汇总' : '按月汇总') +
						'，数据来自 vnstat；单位为 GiB/TiB，建库首' +
						(range === 'day' ? '日' : '月') + '含建库前的接口累计。';
					return;
				}

				state.hist = r;
				var now = Math.floor(Date.now() / 1000);
				state.hist.t1 = Math.max(r.t1 || now, now);
				state.hist.t0 = state.hist.t1 - 86400;

				syncLayout();
				draw();
				refreshTable();

				var plist = r.points || [];
				var span = '';

				if (plist.length) {
					var fts = plist[0].timestamp;
					var d = new Date(fts * 1000);
					span = '；当前 ' + plist.length + ' 个采样点，最早从 ' +
						pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
						pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' 开始';
				}
				else {
					span = '；该时段 vnstat 还没有记录到流量';
				}

				hintEl.textContent = '数据来自 vnstat（5 分钟粒度），最近 24 小时' + span +
					'。灰色区域表示没有采集数据。';
			}).catch(function() {
				state.histLoading = false;
				state.hist = { ok: false, error: 'fail' };
				draw();
				refreshTable();
				hintEl.textContent = '读取历史数据失败（rpcd 未响应）。';
			});
		}

		/* ---------- 控件 ---------- */

		TABS.forEach(function(t) {
			var b = E('button', {
				'class': 'cbi-button' + (state.tab === t[0] ? ' cbi-button-action' : ''),
				click: function() {
					if (state.tab === t[0]) return;
					state.tab = t[0];
					state.hist = null;
					state.rows = [];
					TABS.forEach(function(x) { tabBtns[x[0]].className = 'cbi-button' + (x[0] === state.tab ? ' cbi-button-action' : ''); });
					syncLayout();
					if (state.tab === 'rt') {
						draw();
						refreshTable();
						hintEl.textContent = '数据来自 /sys/class/net 接口计数器，每秒采样一次；「总共量值」为接口自本次开机以来的累计。';
					}
					else {
						loadHistory();
					}
				}
			}, t[1]);
			tabBtns[t[0]] = b;
		});

		var winBox = E('div', { style: 'display:flex;gap:4px' },
			[ [ '1 分钟', 60 ], [ '5 分钟', 300 ], [ '15 分钟', 900 ] ].map(function(w) {
				var b = E('button', {
					'class': 'cbi-button' + (state.win === w[1] ? ' cbi-button-action' : ''),
					click: function() {
						state.win = w[1];
						winBtns.forEach(function(x) { x.className = 'cbi-button'; });
						b.className = 'cbi-button cbi-button-action';
						draw();
						refreshTable();
					}
				}, w[0]);
				winBtns.push(b);
				return b;
			}));

		var sel = E('select', {
			'class': 'cbi-input-select',
			change: function(ev) {
				state.iface = ev.target.value;
				state.samples = [];
				state.last = null;
				state.hist = null;
				state.rows = [];
				state.histKey = '';
				if (state.tab === 'rt') {
					draw();
					refreshTable();
				}
				else {
					loadHistory();
				}
			}
		}, ifaces.map(function(n) {
			return E('option', { value: n, selected: n === state.iface ? '' : null },
				labelFor(n, (res.ifaces || {})[n]));
		}));

		hintEl = E('p', { style: 'margin-top:10px;font-size:12px;color:rgba(128,128,128,1)' },
			'数据来自 /sys/class/net 接口计数器，每秒采样一次；「总共量值」为接口自本次开机以来的累计。');

		/* ---------- 实时采样 ---------- */

		function tick() {
			state.tickCount++;

			if (state.tab !== 'rt') {
				if (state.tickCount % 60 === 0)
					return loadHistory();

				return;
			}

			return callGetRate().then(function(r) {
				var d = (r.ifaces || {})[state.iface];
				if (!d) return;

				var now = Date.now();

				if (state.last && state.last.iface === state.iface) {
					var dt = (now - state.last.t) / 1000;
					if (dt >= 0.5) {
						var down = (d.rx - state.last.rx) * 8 / dt;
						var up = (d.tx - state.last.tx) * 8 / dt;

						if (FLIP[state.iface]) {
							var t = down; down = up; up = t;
						}

						if (!isFinite(down) || down < 0) down = 0;
						if (!isFinite(up) || up < 0) up = 0;

						state.samples.push({ t: now, down: down, up: up });
					}
				}

				state.last = { t: now, rx: d.rx, tx: d.tx, iface: state.iface };
				state.totals[state.iface] = { rx: d.rx, tx: d.tx };

				var cut = now - CAP_MS;
				while (state.samples.length && state.samples[0].t < cut)
					state.samples.shift();

				draw();
				refreshTable();
			});
		}

		setTimeout(function() { draw(); refreshTable(); }, 60);
		poll.add(tick, 1);

		sumTable = E('table', { 'class': 'table' }, [
			E('thead', {}, E('tr', { 'class': 'tr' }, [
				E('th', { 'class': 'th' }, '颜色'),
				E('th', { 'class': 'th' }, '链路'),
				E('th', { 'class': 'th' }, '当前流量值'),
				E('th', { 'class': 'th' }, '平均流量值'),
				E('th', { 'class': 'th' }, '最大流量值'),
				E('th', { 'class': 'th' }, '总共量值')
			])),
			E('tbody', {}, [
				mkRow('down', '下行', COL_DOWN),
				mkRow('up', '上行', COL_UP)
			])
		]);

		histTbody = E('tbody', {});

		histEmpty = E('p', { style: 'padding:16px;color:rgba(128,128,128,1)' }, '该时段没有数据');

		histBox = E('div', { style: 'display:none' }, [
			E('table', { 'class': 'table' }, [
				E('thead', {}, E('tr', { 'class': 'tr' }, [
					histHead = E('th', { 'class': 'th' }, '日期'),
					E('th', { 'class': 'th' }, '下行'),
					E('th', { 'class': 'th' }, '上行'),
					E('th', { 'class': 'th' }, '总共量值')
				])),
				histTbody
			]),
			histEmpty
		]);

		return E('div', { 'class': 'cbi-section' }, [
			E('div', {
				style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px'
			}, [
				E('div', { style: 'display:flex;gap:4px' }, TABS.map(function(t) { return tabBtns[t[0]]; })),
				E('div', { style: 'flex:1' }),
				sel
			]),
			E('div', {
				style: 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px'
			}, [ winBox ]),
			chartBox,
			sumTable,
			histBox,
			hintEl
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
