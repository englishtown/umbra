#!/usr/bin/env node
require('shelljs/global');
var _ = require('lodash');
var cheerio = require('cheerio').load;
var when = require('when');
var fs = require('fs');
var path = require('path');
var node = require('when/node');
var walk = require('walk').walk;
var pkg = require('./package.json');
require('colors').setTheme({
	prompt : 'grey', ok : 'green', warn : 'yellow', fail : 'red'
});

var parseXml = node.lift(require('xml2js').parseString);

require('when/monitor/console');
//require('request-debug')(require('request'), function (type, data, req) {
//	if (type === 'request' && !/(login|logout)\.aspx/.test(req.uri.pathname)) {
//		console.log(req.href, req.headers);
//	}
//});

var request = node.liftAll(require('request').defaults({jar : true}));
var LOGIN_URL = 'http://umbraco.englishtown.com/umbraco/login.aspx';
var CMS_URL = 'http://umbraco.englishtown.com/umbraco/editContent.aspx';
var TREE_URL = 'http://umbraco.englishtown.com/umbraco/tree.aspx';

function extendForm(form, body) {
	var params = {};
	var $ = cheerio(body);
	$('[type="hidden"]').each(function (index, elem) {
		params[$(elem).attr('name')] = $(elem).val() || '';
	});
	return _.extend(form, params);
}

function formPost(url, params) {
	return request.get(url,
	{qs : params.qs}).spread(function (response, get_body) {
		params.form = extendForm(params.form || {}, get_body);
		return request.post(url, params);
	});
}

function auth() {
	return formPost(LOGIN_URL, {
		form : {
			'ctl00$body$lname' : 'garry.yao',
			'ctl00$body$passw' : 'gy123',
			ctl00$body$Button1 : 'Login'
		}
	}).spread(function (res) {
		if (res.statusCode !== 302) {
			throw new Error('authenticate failed');
		}
	});
}

function updateContent(node) {
	return formPost(CMS_URL, {
		qs : {
			id : node.id
		}, form : {
			'ctl00$body$TabView1_tab01layer_publish.x' : 1,
			'ctl00$body$TabView1_tab01layer_publish.y' : 2,
			'ctl00$body$ctl04' : node.val,
			'ctl00$body$NameTxt' : node.name
		}
	});
}

function batch_map(batch_id, batch_name) {
	function fetchBatch(batch_id) {
		return request.get(TREE_URL, {
			qs : {
				id : batch_id, treeType : 'content'
			}
		}).spread(function (res, body) {
			return parseXml(body).then(function (retval) {
				var list = retval.tree.tree;
				return list.map(function (node) {
					node = node.$;
					var retval = {
						id : +node.nodeID, name : node.text
					};
					if (node.hasChildren === 'true') {
						retval.children = [];
					}
					return retval;
				}).filter(function (node) {
					if (!node.name) {
						console.log('[warning] '.warn +
						'CMS id %s has no name specified thus will no be updated', node.id);
					}
					// filter out page without name
					return node.name;
				});
			});
		}).then(function (list) {
			return when.map(list, function (node) {
				// expand collapsed tree node
				if (node.children) {
					return fetchBatch(node.id).tap(function (list) {
						node.children = list;
					}).yield(node);
				}
				return node;
			}).then();
		});
	}

	// collect a key-id map of all batch entries
	function flatten(root) {
		var map = {};
		root.children.forEach(function (node) {
			node.key = [root.name, node.name].join('_');
			if (node.children) {
				_.extend(map, flatten(node));
			} else {
				map[node.key] = node;
			}
			return node;
		});
		return map;
	}

	return fetchBatch(batch_id).then(function (list) {
		return flatten({
			id : batch_id, name : batch_name, children : list
		});
	});
}

var cli = require('commander').version(pkg.version);
cli.description(pkg.description);

cli.command('pub').description('publishing local cms directory to Umbraco in a batch').action(function () {
	auth().then(function () {
		batch_map(29641, 'Camp').then(function (map) {
			// go through the list of local git CMS files for publishing.
			walk("./cms", {followLinks : false}).on('file',
			function (dir, file, next) {
				var key = path.basename(file.name, path.extname(file.name));
				var val = fs.readFileSync(path.join(dir, file.name), 'utf8');
				var node;
				if (node = map[key]) {
					node.val = val;
					updateContent(node).spread(function () {
						console.log('[ok] '.ok + '%s (%s) has been published as "%s"',
						node.key, node.id, _.trunc(node.val, 40));
					}).catch(function () {
						console.error('[fail] '.fail +
						'%s (%s) has failed to publish, try later.'.error);
					});
				}
				next();
			});
		});
	});
});

cli.parse(process.argv);

// no second argv
if (process.argv.length === 2) {
	cli.help();
}
