#!/usr/bin/env node
require('shelljs/global');
var _ = require('lodash');
var cheerio = require('cheerio').load;
var when = require('when');
var fs = require('fs');
var path = require('path');
var node = require('when/node');
var walk = require('walk').walk;
var prompt = require('prompt');
var pkg = require('./package.json');
var HOME_PATH = (function () {
	return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
})();
var nconf = require('nconf').argv().file({file : path.join(HOME_PATH, 'umbra.auth.json')});
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

function extendForm(form, $) {
	var params = {};
	$('[type="hidden"]').each(function (index, elem) {
		params[$(elem).attr('name')] = $(elem).val() || '';
	});
	return _.extend(form, params);
}

function formPost(url, params) {
	return request.get(url,
	{qs : params.qs}).spread(function (response, get_body) {
		var $ = cheerio(get_body);
		// when we has to construct the form dynamically
		if(typeof params.form === 'function') {
			params.form = params.form($);
		}
		params.form = extendForm(params.form || {}, $);
		return request.post(url, params);
	});
}

/* simple authentication storage */
function saveAuth(username, password) {
	nconf.save();
}
function getAuth(usePrompt) {
	return when.promise(function (resolve) {
		// use prompt for authentication
		if (usePrompt || cli.auth || !nconf.get('auth')) {
			prompt.get([
				{
					name : 'username', required : true
				}, {
					name : 'password', hidden : true, conform : function (value) {
						return true;
					}
				}
			], function (err, result) {
				nconf.set('auth:username', result.username);
				nconf.set('auth:password', result.password);
				resolve();
			});
		} else {
			resolve();
		}
	}).then(function () {
		return [nconf.get('auth:username'), nconf.get('auth:password')];
	});
}

function auth(usePrompt) {
	return getAuth(usePrompt).spread(function (username, password) {
		return formPost(LOGIN_URL, {
			form : {
				'ctl00$body$lname' : username,
				'ctl00$body$passw' : password,
				ctl00$body$Button1 : 'Login'
			}
		}).spread(function (res) {
			// authentication failed
			if (res.statusCode !== 302) {
				console.error('authentication failed, try again.'.fail);
				return auth(true);
			} else {
				/* persist on auth success */
				saveAuth({
					username : username, password : password
				});
			}
		});
	});
}

function updateContent(node) {
	return formPost(CMS_URL, {
		qs : {
			id : node.id
		},
		form : function prepareForm($) {
			var retval = {
				'ctl00$body$TabView1_tab01layer_publish.x' : 1,
				'ctl00$body$TabView1_tab01layer_publish.y' : 2,
				'ctl00$body$NameTxt' : node.name
			};
			var contentTabIndex = $('.header li > a > span > nobr:contains("Content")').closest('li').index() + 1;
			var content_name = $('.tabpage:nth-child('+ contentTabIndex+ ') .tabpageContent textarea').eq(0).attr('name');
			retval[content_name] = node.val;
			return retval;
		}
	});
}

function getContent(id) {
	// guess extension by content: "json", "html" or "text"
	function guess_extension(str) {
		try {
			JSON.parse(str);
			return 'json';
		} catch (er) {
			var $ = cheerio(str);
			if ($('*').length)
				return 'html';
		}
		return 'txt';
	}

	return request.get(CMS_URL, {
		qs : {id : id}
	}).spread(function (response, body) {
		var $ = cheerio(body);
		var content = $('[name="ctl00$body$ctl08"]').val() || $('[name="ctl00$body$ctl04"]').val();
		return {
			id: id,
			key: $('[name="ctl00$body$NameTxt"]').val(),
			type: guess_extension(content),
			val: content
		};
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
			node.key = [root.key || root.name, node.name].join('_').toLowerCase();
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
cli.description(pkg.description)
.option('-i, --auth', 'whether to invalidate authentication store and prompt for username and password');

cli.command('push [files...]').description('publish specific file(s) or the entire "cms" directory to Umbraco').action(function (files) {
	files = files.length ? _.indexBy(files, function (file) { return file.toLowerCase(); }) : null;

	auth().then(function () {
		batch_map(29641, 'Camp').then(function (map) {
			// go through the list of local git CMS files for publishing.
			walk("./cms", {followLinks : false}).on('file',
			function (dir, file, next) {
				var p = path.join(dir, file.name).toLowerCase();

				// skip files that are not in the list
				if (files && !(p in files)) {
					return next();
				}

				var key = path.basename(file.name, path.extname(file.name)).toLowerCase();
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

cli.command('pull').description('fetch newly created Umbraco contents back to the "cms" directory').action(function () {
	var existing = {};
	// go through the list of local git CMS files for publishing.
	walk("./cms", {followLinks : false}).on('file', function (dir, file, next) {
		var key = path.basename(file.name, path.extname(file.name));
		existing[key.toLowerCase()] = 1;
		next();
	}).on('end', function () {
		auth().then(function () {
			batch_map(29641, 'Camp').then(function (nodes) {
				nodes = _.chain(nodes).map(function (node, key) {
					if (!(key.toLowerCase() in existing)) {
						// create new file
						return getContent(node.id).then(function (node) {
							var file = path.join('cms', key);
							if(node.type) { file += ('.' + node.type) }
							console.log('creating file %s', file);
							fs.writeFileSync(file, node.val);
						})
					}
				}).compact().value();
				return when.map(nodes).then(function () {
					console.log('all files are up-to-date.');
				});
			});
		});
	});
});

cli.parse(process.argv);

// no second argv
if (process.argv.length === 2) {
	cli.help();
}
