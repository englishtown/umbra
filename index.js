#!/usr/bin/env node
require('shelljs/global');
var _ = require('lodash');
var cheerio = require('cheerio').load;
var when = require('when');
var fs = require('fs');
var path = require('path');
var node = require('when/node');
var pipeline = require('when/pipeline');
var walk = require('walk').walk;
var prompt = require('prompt');
var json = require('jsonfile');
var pkg = require('./package.json');
var HOME_PATH = (function () {
	return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
})();
var nconf = require('nconf').argv().file({
	file : path.join(HOME_PATH, 'umbra.auth.json')
});
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
		if (typeof params.form === 'function') {
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
		}, form : function prepareForm($) {
			var retval = {
				'ctl00$body$TabView1_tab01layer_publish.x' : 1,
				'ctl00$body$TabView1_tab01layer_publish.y' : 2,
				'ctl00$body$NameTxt' : node.name
			};
			var contentTabIndex = $('.header li > a > span > nobr:contains("Content")').closest('li').index() +
			1;
			var content_name = $('.tabpage:nth-child(' + contentTabIndex +
			') .tabpageContent textarea').eq(0).attr('name');
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
			if ($('*').length) {
				return 'html';
			}
		}
		return 'txt';
	}

	return request.get(CMS_URL, {
		qs : {id : id}
	}).spread(function (response, body) {
		var $ = cheerio(body);
		var content = $('[name="ctl00$body$ctl08"]').val() ||
		$('[name="ctl00$body$ctl04"]').val();
		return {
			id : id,
			key : $('[name="ctl00$body$NameTxt"]').val(),
			type : guess_extension(content),
			val : content
		};
	});
}

/* fetch the tree nodes of the specified Umbraco ID */
function fetch(nodeId, nodeName, isRecursive) {
	function fetchNode(node_id) {
		return request.get(TREE_URL, {
			qs : {
				id : node_id, treeType : 'content'
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
					// filter out page without name
					return node.name;
				});
			});
		}).then(function (list) {
			// Non-recursive fetch shall stop here.
			if (!isRecursive) {
				return list;
			}
			return when.map(list, function (node) {
				// expand collapsed tree node
				if (node.children) {
					return fetchNode(node.id).tap(function (list) {
						node.children = list;
					}).yield(node);
				}
				return node;
			});
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

	return fetchNode(nodeId).then(function (list) {
		if (!isRecursive) {
			return list;
		}

		return flatten({
			id : nodeId, name : nodeName, children : list
		});
	});
}
/* locate the content tree node of the specified path */
function locate(cmsPath) {

	// make sure there's a root path
	if (!/^\//.test(cmsPath)) {
		cmsPath = '/' + cmsPath;
	}

	var paths = cmsPath.split('/').map(function (seg) {
		return seg.toLowerCase();
	});

	function fetchMap(cmsId, cmsName) {
		return fetch(cmsId, cmsName).then(function (list) {
			return _.chain(list).indexBy(function (node) {
				return node.name.toLowerCase();
			}).mapValues(function (val) {
				return val.id;
			}).value();
		});
	}

	return pipeline(paths.map(function (segment, index) {
		return function task(map) {
			var cmsId = index === 0 ? -1 : map[segment];
			var cmsKey = index === 0 ? 'Content' : segment;
			if (cmsId) {
				/* already at the end of path */
				if (index === paths.length - 1) {
					return [_.compact(paths).join('_'), cmsId];
				} else {
					return fetchMap(cmsId, cmsKey);
				}
			} else {
				when.reject(new Error('No CMS node at path: ' + paths.join('/')));
			}
		};
	}));
}

function repo_config(dir, val) {
	var file = path.join(dir, '.umbra');
	if (val) {
		mkdir('-p', dir);
		return json.writeFileSync(file, val);
	} else {
		return test('-e', file) ? json.readFileSync(file) : null;
	}
}
// read the repository info at the current path
function repo_pwd() {
	var repo = repo_config('.');
	if (!repo) {
		console.log("fatal: Not an umbraco repository. Try 'umbra clone' first.");
		exit(1);
	}
	return repo;
}

function commandClone(cms_path, dir) {
	var repo = repo_config(dir);
	if (repo) {
		console.error("Fatal: repository already exists on destination path '%s'.",
		repo.dir);
		return;
	}

	var me = this;
	console.log("Cloning '%s' into '%s'", cms_path, dir);
	auth().then(function () {
		locate(cms_path).spread(function (cmsKey, cmsId) {
			repo_config(dir, {
				key : cmsKey, id : cmsId, dir : dir,
			})
			cd(dir);
			return commandPull().then(function () {
				console.log('Clone is done.'.ok);
			});
		});
	});
}

function commandPull() {
	var repo = repo_pwd();
	var existing = {};
	console.log("Pulling CMS node from: '%s'(%s)...", repo.key, repo.id);
	return when.promise(function (resolve) {
		// go through the list of local git CMS files for publishing.
		walk('.', {followLinks : false}).on('file', function (dir, file, next) {
			var key = path.basename(file.name, path.extname(file.name));
			existing[key.toLowerCase()] = 1;
			next();
		}).on('end', function () {
			auth().then(function () {
				fetch(repo.id, repo.key, true).then(function (nodes) {
					nodes = _.chain(nodes).map(function (node, key) {
						if (!(key.toLowerCase() in existing)) {
							// create new file
							return getContent(node.id).then(function (node) {
								var file = key;
								if (node.type) { file += ('.' + node.type) }
								console.log('creating file %s', file);
								fs.writeFileSync(file, node.val);
							})
						}
					}).compact().value();
					if (nodes.length) {
						return when.map(nodes);
					}
				}).tap(function () {
					console.log('All files are up-to-date.'.ok);
				}).then(resolve);
			});
		});
	});
}
function commandPush(files) {
	var repo = repo_pwd();
	files = files.length ? _.indexBy(files,
	function (file) { return file.toLowerCase(); }) : null;

	console.log("Pushing CMS nodes to: '%s'(%s)...", repo.key, repo.id);

	auth().then(function () {
		fetch(repo.id, repo.key, true).then(function (map) {
			// go through the list of local git CMS files for publishing.
			walk('.', {followLinks : false}).on('file', function (dir, file, next) {
				var p = file.name.toLowerCase();
				// skip files that are not in the list
				if (files && !(p in files)) {
					return next();
				}

				var key = path.basename(file.name,
				path.extname(file.name)).toLowerCase();
				var val = fs.readFileSync(file.name, 'utf8');
				var node;
				if (node = map[key]) {
					node.val = val;
					updateContent(node).then(function () {
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
}

var cli = require('commander').version(pkg.version);
cli.description(pkg.description).option('-i, --auth',
'whether to invalidate authentication store and prompt for username and password');

cli.command('clone <path> <dir>').description('track remote content tree nodes as local file from a specified path in Umbraco').action(commandClone);
cli.command('pull').description('fetch newly created Umbraco nodes as local files').action(commandPull);
cli.command('push [files...]').description('publish one or more local files changes to the corresponding CMS node in Umbraco').action(commandPush);

cli.parse(process.argv);

// no second argv
if (process.argv.length === 2) {
	cli.help();
}
