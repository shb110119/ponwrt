// This is free software, licensed under the Apache License, Version 2.0
/* 本地修改版：把 vnstati 生成的 PNG 图表替换为可复制、可选中的文本表格。
   数据直接来自 `vnstat --json`，不再调用 vnstati。
   基于上游 openwrt/luci applications/luci-app-vnstat2 graphs.js（a5ec60d483）改写，
   上游升级后如需跟进需重新对位。 */

'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require rpc';

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

var isReadonlyView = !L.hasViewPermission() || null;

var tabBoxes = [];

/* 每个接口只发起一次 exec（promise 去重），7 个标签页共用同一份 JSON */
var dataPromises = {};

function getIfaceData(iface) {
	if (!dataPromises[iface]) {
		dataPromises[iface] = fs.exec_direct('/usr/bin/vnstat', [ '--json', '-i', iface ], 'text').then(function(txt) {
			var data = JSON.parse(txt);

			if (!data || !data.interfaces || !data.interfaces.length)
				throw new Error('no interface data');

			return data.interfaces[0];
		});
	}

	return dataPromises[iface];
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

function fmtBytes(b) {
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
	var k = 0, v = b;

	while (v >= 1024 && k < u.length - 1) { v /= 1024; k++; }

	if (k == 0) return v + ' ' + u[k];
	if (v >= 100) return v.toFixed(0) + ' ' + u[k];
	if (v >= 10) return v.toFixed(1) + ' ' + u[k];
	return v.toFixed(2) + ' ' + u[k];
}

/* vnstat 2.x JSON 的条目形如 { date:{year,month,day}, time:{hour,minute}, timestamp }；
   其中 timestamp 是"本机挂钟当 UTC"的伪 epoch，浏览器端直接转换会差时区，
   所以一律从 date/time 字段格式化。e 为条目对象。 */
function fmtTs(e, style) {
	var d = (e && e.date) || {};
	var t = (e && e.time) || {};

	if (!d.year)
		return '-';

	switch (style) {
		case 'day':   return d.year + '-' + pad(d.month) + '-' + pad(d.day);
		case 'month': return d.year + '-' + pad(d.month);
		case 'year':  return String(d.year);
		case 'hour':  return pad(d.month) + '-' + pad(d.day) + ' ' + pad(t.hour || 0) + ':00';
		case 'fmin':  return pad(d.month) + '-' + pad(d.day) + ' ' + pad(t.hour || 0) + ':' + pad(t.minute || 0);
	}

	return d.year + '-' + pad(d.month) + '-' + pad(d.day) +
		(t.hour != null ? ' ' + pad(t.hour) + ':' + pad(t.minute || 0) : '');
}

/* 速率：bytes/秒 → vnstat 风格 bit/s 单位 */
function fmtRate(bytes, secs) {
	if (!secs || secs <= 0)
		return '-';

	var bps = (bytes || 0) * 8 / secs;
	var u = [ 'bit/s', 'Kibit/s', 'Mibit/s', 'Gibit/s', 'Tibit/s' ];
	var k = 0, v = bps;

	while (v >= 1024 && k < u.length - 1) { v /= 1024; k++; }

	if (v >= 100) return v.toFixed(0) + ' ' + u[k];
	if (v >= 10) return v.toFixed(1) + ' ' + u[k];
	return v.toFixed(2) + ' ' + u[k];
}

/* 浏览器与设备同为 CST，直接用本地时间判断"今天/本月" */
function isToday(e) {
	var d = new Date();

	return e && e.date && e.date.year == d.getFullYear() &&
		e.date.month == (d.getMonth() + 1) && e.date.day == d.getDate();
}

function isThisMonth(e) {
	var d = new Date();

	return e && e.date && e.date.year == d.getFullYear() &&
		e.date.month == (d.getMonth() + 1);
}

function secsIntoMonth() {
	var d = new Date();

	return (d.getDate() - 1) * 86400 + d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function secsIntoDay() {
	var d = new Date();

	return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function daysInMonth() {
	var d = new Date();

	return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/* 日/月的"预估"：按已过时间线性外推到整日/整月 */
function estTot(e, kind) {
	var tot = (e && e.rx != null && e.tx != null) ? (e.rx + e.tx) : null;

	if (tot == null)
		return '-';

	if (kind == 'day') {
		if (!isToday(e))
			return '-';

		var el = secsIntoDay();

		return (el > 60) ? fmtBytes(tot / el * 86400) : '-';
	}

	if (kind == 'month') {
		if (!isThisMonth(e))
			return '-';

		var el = secsIntoMonth();

		return (el > 600) ? fmtBytes(tot / el * (daysInMonth() * 86400)) : '-';
	}

	return '-';
}

function rev(a) { return (a || []).slice().reverse(); }

/* 各标签页：从 traffic 里取数，返回 { headers, rows } */
function buildRows(mode, idata) {
	var tr = (idata && idata.traffic) || {};
	var none = { headers: [ '-' ], rows: [ [ '暂无数据' ] ] };

	switch (mode) {
		case 's': {
			var total = tr.total || {};
			var day = (tr.day || []).slice(-1).pop();
			var mon = (tr.month || []).slice(-1).pop();
			var rows = [
				[ '数据起始', fmtTs(idata.created), '', '' ],
				[ '最后更新', fmtTs(idata.updated), '', '' ],
				[ '总计', fmtBytes(total.rx || 0), fmtBytes(total.tx || 0), fmtBytes((total.rx || 0) + (total.tx || 0)) ]
			];

			if (day)
				rows.push([ '今日 ' + fmtTs(day, 'day'), fmtBytes(day.rx), fmtBytes(day.tx), fmtBytes(day.rx + day.tx) ]);

			if (mon)
				rows.push([ '本月 ' + fmtTs(mon, 'month'), fmtBytes(mon.rx), fmtBytes(mon.tx), fmtBytes(mon.rx + mon.tx) ]);

			return { headers: [ '范围', '下行', '上行', '合计' ], rows: rows };
		}

		case 't':
			return {
				headers: [ '#', '日期', '下行', '上行', '合计' ],
				rows: (tr.top || []).map(function(e, i) {
					return [ i + 1, fmtTs(e, 'day'), fmtBytes(e.rx), fmtBytes(e.tx), fmtBytes(e.rx + e.tx) ];
				})
			};

		case '5':
			/* 与 vnstati -5 默认一致：最新 24 条 */
			return {
				headers: [ '时间', '下行', '上行', '合计', '平均速率' ],
				rows: rev(tr.fiveminute).slice(0, 24).map(function(e) {
					return [ fmtTs(e, 'fmin'), fmtBytes(e.rx), fmtBytes(e.tx), fmtBytes(e.rx + e.tx), fmtRate(e.rx + e.tx, 300) ];
				})
			};

		case 'h':
			/* 与 vnstati -h 默认一致：最新 24 条 */
			return {
				headers: [ '时间', '下行', '上行', '合计', '平均速率' ],
				rows: rev(tr.hour).slice(0, 24).map(function(e) {
					return [ fmtTs(e, 'hour'), fmtBytes(e.rx), fmtBytes(e.tx), fmtBytes(e.rx + e.tx), fmtRate(e.rx + e.tx, 3600) ];
				})
			};

		case 'd':
			return {
				headers: [ '日期', '下行', '上行', '合计', '平均速率', '当日预估' ],
				rows: rev(tr.day).map(function(e) {
					return [ fmtTs(e, 'day'), fmtBytes(e.rx), fmtBytes(e.tx), fmtBytes(e.rx + e.tx),
						fmtRate(e.rx + e.tx, isToday(e) ? secsIntoDay() : 86400), estTot(e, 'day') ];
				})
			};

		case 'm':
			return {
				headers: [ '月份', '下行', '上行', '合计', '当月预估' ],
				rows: rev(tr.month).map(function(e) {
					return [ fmtTs(e, 'month'), fmtBytes(e.rx), fmtBytes(e.tx), fmtBytes(e.rx + e.tx), estTot(e, 'month') ];
				})
			};

		case 'y':
			return {
				headers: [ '年份', '下行', '上行', '合计' ],
				rows: rev(tr.year).map(function(e) {
					return [ fmtTs(e, 'year'), fmtBytes(e.rx), fmtBytes(e.tx), fmtBytes(e.rx + e.tx) ];
				})
			};
	}

	return none;
}

function tableFrom(headers, rows) {
	var tbl = E('table', { 'class': 'vnstat-tbl' });
	var trh = E('tr');

	headers.forEach(function(h) { trh.appendChild(E('th', {}, h)); });
	tbl.appendChild(E('thead', {}, trh));

	var tb = E('tbody');

	rows.forEach(function(r) {
		var tr = E('tr');

		r.forEach(function(c, i) {
			tr.appendChild(E('td', { 'class': i ? 'num' : '' }, String(c)));
		});
		tb.appendChild(tr);
	});
	tbl.appendChild(tb);

	return tbl;
}

function copyButton(rows, headers) {
	return E('button', {
		'class': 'cbi-button cbi-button-neutral',
		'style': 'margin:2px 0 8px',
		'click': function(ev) {
			var lines = [ headers.join('\t') ];

			rows.forEach(function(r) { lines.push(r.join('\t')); });

			var ta = document.createElement('textarea');
			ta.value = lines.join('\n');
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();

			try {
				document.execCommand('copy');
				ev.target.textContent = '已复制到剪贴板';
			}
			catch (e) {
				ev.target.textContent = '复制失败，请手动选中表格文字复制';
			}

			document.body.removeChild(ta);

			window.setTimeout(function() { ev.target.textContent = '复制本表'; }, 2000);
		}
	}, '复制本表');
}

function IfacesResetData(ev) {
	ui.showModal(_('Delete data for ALL interfaces'), [
		E('p', {}, _('The data will be removed from the database permanently. This cannot be undone.')),
		E('div', { 'class': 'right' }, [
			E('div', {
				'class': 'btn',
				'click': L.hideModal
			}, _('Cancel')),
			' ',
			E('div', {
				'class': 'btn cbi-button-negative',
				'click': function(ev) {
					var if_count = 0;
					var ifaces = uci.get_first('vnstat', 'vnstat', 'interface') || [];

					ifaces.forEach(function (iface) {
						fs.exec_direct('/usr/bin/vnstat', [ '--remove', '-i', iface, '--force' ], 'blob').then(function() {
							fs.exec_direct('/usr/bin/vnstat', [ '--add', '-i', iface ], 'blob').then(function() {
								if_count++;

								if (if_count == ifaces.length) {
									dataPromises = {};
									tabBoxes.forEach(function(b) { b.reload(); });
								}
							});
						});
					});
					ui.hideModal();
				}
			}, _('Delete'))
		])
	]);
}

return view.extend({
	fillTab: function(box, ifaces, mode) {
		var self = this;

		while (box.firstElementChild)
			box.removeChild(box.firstElementChild);

		box.appendChild(E('p', {}, E('em', { 'class': 'spinning' }, [ _('Loading data…') ])));

		return Promise.all(ifaces.map(function(iface) {
			return getIfaceData(iface).then(function(idata) {
				return { iface: iface, idata: idata };
			});
		})).then(function(results) {
			while (box.firstElementChild)
				box.removeChild(box.firstElementChild);

			var grid = E('div', { 'class': 'vnstat-grid' });

			results.forEach(function(res) {
				var tr = res.idata.traffic || {};
				var built = buildRows(mode, res.idata);
				var wrap = E('div', {}, [
					E('h3', {}, res.iface),
					copyButton(built.rows, built.headers)
				]);

				var tbl = tableFrom(built.headers, built.rows);

				if (mode == '5' || mode == 'h' || mode == 'd' || mode == 'm')
					wrap.appendChild(E('div', { 'class': 'vnstat-scroll' }, tbl));
				else
					wrap.appendChild(tbl);

				grid.appendChild(wrap);
			});

			box.appendChild(grid);
		}).catch(function(e) {
			while (box.firstElementChild)
				box.removeChild(box.firstElementChild);

			box.appendChild(E('p', { 'class': 'alert-message warning' },
				'读取 vnstat 数据失败：' + (e.message || e)));
		});
	},

	renderTab: function(ifaces, mode, title) {
		var self = this;
		var box = E('div', {
			'class': 'cbi-section',
			'data-tab': mode,
			'data-tab-title': title
		});

		box.reload = function() { return self.fillTab(box, ifaces, mode); };
		tabBoxes.push(box);
		box.reload();

		return box;
	},

	load: function() {
		return Promise.all([
			L.resolveDefault(callServiceList('vnstat'), {}),
			uci.load('vnstat'),
		]);
	},

	render: function(data) {
		var self = this;
		var ifaces = uci.get_first('vnstat', 'vnstat', 'interface') || [];
		var isRunning = false;

		try {
			isRunning = data[0]['vnstat']['instances']['instance1']['running'];
		} catch (e) { }

		var tabsDiv = E('div', ifaces.length ? [
			self.renderTab(ifaces, 's', _('Summary')),
			self.renderTab(ifaces, 't', _('Top')),
			self.renderTab(ifaces, '5', _('5 Minute')),
			self.renderTab(ifaces, 'h', _('Hourly')),
			self.renderTab(ifaces, 'd', _('Daily')),
			self.renderTab(ifaces, 'm', _('Monthly')),
			self.renderTab(ifaces, 'y', _('Yearly'))
		] : [ E('em', {}, [ _('No monitored interfaces have been found. Go to the configuration to enable monitoring for one or more interfaces.') ]) ]);

		var view = E([], [
			E('style', { 'type': 'text/css' },
				'.vnstat-tbl{border-collapse:collapse;margin:4px 0 12px}' +
				'.vnstat-tbl th,.vnstat-tbl td{border:1px solid #d4d4d4;padding:3px 10px;font-size:12px;white-space:nowrap}' +
				'.vnstat-tbl th{background:rgba(0,0,0,.05);text-align:center}' +
				'.vnstat-tbl td.num{text-align:right}' +
				'.vnstat-grid{display:flex;flex-wrap:wrap;align-items:flex-start}' +
				'.vnstat-grid>div{flex:1 1 46%;min-width:320px;box-sizing:border-box;padding:2px 8px 8px 2px}' +
				'.vnstat-scroll{max-height:420px;overflow:auto;border:1px solid #d4d4d4;padding:2px}'),

			E('h2', {}, [ _('vnStat Graphs') ]),

			(isRunning == false) ? E('p', { 'class': 'alert-message warning' }, _('Warning: The service is not running, graphs will not be updated!')) : E('p'),

			tabsDiv,

			E('div', { 'class': 'right' }, [
				E('br'),
				ifaces.length ? E('button', {
					'class': 'cbi-button cbi-button-positive',
					'click': function() {
						dataPromises = {};
						tabBoxes.forEach(function(b) { b.reload(); });
					}
				}, [ '刷新数据' ]) : E(''),
				' ',
				ifaces.length ? E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': IfacesResetData,
					'disabled': isReadonlyView
				}, [ _('Clear data for all interfaces') ]) : E('')
			])
		]);

		if (ifaces.length)
			ui.tabs.initTabGroup(tabsDiv.childNodes);

		return view;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
