"use strict";

// builtin
var http = require('http');
var util = require('util');
var rl = require('readline').createInterface(process.stdin, process.stdout, null);

// npm
var Seq = require('seq');

var CONFIG_PAGE = 'Benutzer:RevoBot/config.js';
var LOCAL_API = {
  host: 'de.wikipedia.org',
  port: 80,
  path: '/w/api.php'
};
var SHARED_API = {
  host: 'commons.wikimedia.org',
  port: 80,
  path: '/w/api.php'
};

var PICTURES_IN_PARALLEL = 10;
var GAPLIMIT = '500';
var GRCLIMIT = '500';

var credentials = {
  name: null,
  pass: null
};
var cookie = {};
var config = {
  pageid: null,
  oldid:  null,
  title:  null,
  data:   null
};

function Api(api, cookie) {
  function exec(action, attrs, callback) {
    var headers = {
      'Connection':   'keep-alive',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host':         api.host,
      'User-Agent':   'Mozilla/5.0 (Node; U; de) RevoBot/3.0 +http://de.wikipedia.org/wiki/Benutzer:RevoBot'
    };

    for(var e in cookie) {
      if('cookie' in headers)
        headers.cookie += '; '
      else
        headers.cookie = '';
      headers.cookie += encodeURIComponent(e) + '=' + encodeURIComponent(cookie[e]);
    }

    var post = 'action=' + encodeURIComponent(action) + '&format=json';
    for(var a in attrs) {
      if(attrs[a] === false)
        continue;
      post += '&' + encodeURIComponent(a);
      post += '=' + encodeURIComponent(attrs[a]);
    }
    headers['Content-Length'] = post.length;

    var options = {
      host:    api.host,
      port:    api.port,
      method:  'POST',
      path:    api.path,
      headers: headers
    };

    function onError(err) {
      callback(err, null);
    }

    function onRes(res) {
      var finished = false;
      var allData = '';

      function onData(data) {
        allData += data;
      }

      function onEnd() {
        if(finished)
          return;
        finished = true;
        var data = JSON.parse(allData);
        if('error' in data)
          throw new Error(util.inspect(data));
        else
          callback(null, { res: res, data: data });
      }

      function onClose(err) {
        if(finished)
          return;
        finished = true;

        callback(err, { res:res, data: allData });
      }

      res.on('data',  onData);
      res.on('end',   onEnd);
      res.on('close', onClose);
    }
    var req = http.request(options, onRes);
    req.on('error', onError);
    req.end(post);
  }

  function stripNS(info) {
    if(!this.namespaces[info.ns])
      return info.title;
    else
      return info.title.substring(this.namespaces[info.ns].length + 1);
  }

  this.namespaces = {};
  this.exec = exec;
  this.stripNS = stripNS;
}

var local = new Api(LOCAL_API, cookie);
var shared = new Api(SHARED_API, cookie);

function askCredentials(credentials, callback) {
  rl.question('Username: ', function(name) {
    credentials.name = name.trim();
    rl.question('Password [DISPLAYED!!!]: ', function(pass) {
      credentials.pass = pass.trim();
      callback(null, credentials);
    });
  });
}

function login(cookie, name, pass, callback) {
  function onRes(err, res) {
    if(err)
      return callback(err);
    if(res.data.login.result === 'NeedToken') {
      cookie[res.data.login.cookieprefix + '_session'] = res.data.login.sessionid;
      local.exec('login', {
        lgname: name,
        lgpassword: pass,
        lgtoken: res.data.login.token
      }, onRes);
    } else if(res.data.login.result === 'Success') {
      cookie[res.data.login.cookieprefix + '_session'] = res.data.login.sessionid;
      cookie[res.data.login.cookieprefix + 'UserName'] = res.data.login.lgusername;
      cookie[res.data.login.cookieprefix + 'UserID']   = res.data.login.lguserid;
      cookie[res.data.login.cookieprefix + 'Token']    = res.data.login.lgtoken;
      callback(null, cookie);
    } else {
      callback({unknown_result: res.data});
    }
  }

  local.exec('login', {
    lgname: name,
    lgpassword: pass
  }, onRes);
}

function readMetaNamespaces(api, callback) {
  api.exec('query', {
    meta: 'siteinfo',
    siprop: 'namespaces'
  }, function(err, res) {
    if(err)
      return callback(err);
    for(var e in res.data.query.namespaces)
      api.namespaces[e] = res.data.query.namespaces[e]['*'] || null;
    callback(null, api);
  });
}

function readConfig(config, page, callback) {
  function onRes(err, res) {
    if(err)
      return callback(err);

    config.pageid = +res.data.query.pageids[0];
    config.title  = res.data.query.pages[config.pageid].title;
    var rev       = res.data.query.pages[config.pageid].revisions[0];
    config.oldid  = rev.revid;
    config.data   = JSON.parse(rev['*']);

    callback(null, config);
  }

  local.exec('query', {
    prop:         'revisions',
    rvprop:       'ids|content',
    rvlimit:      1,
    redirects:    true,
    indexpageids: true,
    titles:       page
  }, onRes);
}

function traverseGenerator(generator, cont, options, callback) {
  options.generator   = generator;
  options.prop        = 'info|imageinfo|templates';
  options.inprop      = 'protection'
  options.intoken     = 'edit',
  options.iilimit     = 1;
  options.iiprop      = 'size|sha1';
  options.tlnamespace = 10;
  options.tllimit     = 'max';

  function query(c) {
    if(c) {
      options[cont] = c;
      console.log("... " + c);
    } else {
      console.log("Starting ...");
    }
    local.exec('query', options, process);
  }

  function process(err, res) {
    if(err)
      return callback(err);
    var imageInfos = [];
    for(var e in res.data.query.pages)
      imageInfos.push(res.data.query.pages[e]);
    Seq(imageInfos)
      .parEach(PICTURES_IN_PARALLEL, function(imageInfo) {
        processImage(imageInfo, this);
      })
      .seq(function() {
        if('query-continue' in res.data)
          query(res.data['query-continue'][generator][cont]);
        else
          callback(null);
      });
  }

  query(null);
}

function traverseAllImages(callback) {
  traverseGenerator('allpages', 'gapfrom', {
    gapdir:       'ascending',
    gapnamespace: 6,
    gaplimit:     GAPLIMIT
  }, callback);
}

function traverseRC(grcstart, callback) {
  traverseGenerator('recentchanges', 'grcstart', {
    grcdir:         'newer',
    grcnamespace:   6,
    grclimit:       GRCLIMIT,
    grcexcludeuser: credentials.name,
    grctype:        'edit|new',
    grctoponly:     true
  }, callback);
}

function hasTemplateFor(type, imageInfo, yes, no) {
  if(imageInfo.templates)
    for(var i = 0; i < imageInfo.templates.length; ++i)
      if(config.data[type]['*'].indexOf(local.stripNS(imageInfo.templates[i])) >= 0)
        return yes();
  no();
}

function processImage(imageInfo, callback) {
  if('missing' in imageInfo
     || 'redirect' in imageInfo
     || config.data['ignored file'].indexOf(local.stripNS(imageInfo)) >= 0) {
    callback(null);
    return;
  }

  var type;
  if(imageInfo.imagerepository === 'local') {
    type = 'local';
  } else if(imageInfo.imagerepository === 'shared') {
    type = 'commonsseite';
  } else {
    type = 'missing';
  }

  hasTemplateFor(type, imageInfo, function() {
    findCommonsDuplicate(imageInfo, callback);
  }, function() {
    editImage(imageInfo, type, callback);
  });
}

function findCommonsDuplicate(imageInfo, callback) {
  shared.exec('query', {
    prop:         'categories',
    cllimit:      'max',
    indexpageids: true,
    generator:    'allimages',
    gailimit:     'max',
    gaiminsize:   imageInfo.imageinfo[0].size,
    gaimaxsize:   imageInfo.imageinfo[0].size,
    gaisha1:      imageInfo.imageinfo[0].sha1
  }, function(err, res) {
    function hasIgnoredCat() {
      for(var i = 0; i < page.categories.length; ++i)
        if(config.data['commons ignore category'].indexOf(shared.stripNS(page.categories[i])) >= 0)
          return true;
      return false;
    }

    if(err)
      return callback(err);

    var noShadow = false;
    if(!!res.data.query && !!res.data.query.pageids && !!res.data.query.pageids.length) {
      for(var i = 0; i < res.data.query.pageids.length; ++i) {
        var page = res.data.query.pages[ res.data.query.pageids[i] ];

        if(hasIgnoredCat())
          continue;

        if(shared.stripNS(page) === local.stripNS(imageInfo)) {
          var type = 'duplicate';
          noShadow = true;
        } else {
          var type = 'renamed duplicate';
        }

        return hasTemplateFor(type, imageInfo, function() {
          findShadow(imageInfo, callback);
        }, function() {
          editImage(imageInfo, type, callback, {
            '%commons name%': shared.stripNS(page)
          });
        });
      }
    }

    if(!noShadow)
      findShadow(imageInfo, callback);
    else
      callback(null);
  });
}

function findShadow(imageInfo, callback) {
  // TODO
  return callback(null);
}

function editImage(imageInfo, type, callback, replacements) {
  var options = {
    title:          imageInfo.title,
    starttimestamp: imageInfo.starttimestamp,
    token:          imageInfo.edittoken,

    minor:          true,
    bot:            true,
    assert:         'bot',
    nocreate:       true,

    summary:        config.data[type].summary,
    prependtext:    config.data[type].prepend,
    appendtext:     config.data[type].append
  };

  function applyReplacements(text) {
    if(!!replacements)
      for(var e in replacements)
        text = text.replace(e, replacements[e]);
    return text;
  }

  if(!options.summary)
    return callback(null);
  else
    options.summary = applyReplacements(options.summary);

  if(!options.prependtext)
    delete options.prependtext;
  else
    options.prependtext = applyReplacements(options.prependtext) + '\n\n';

  if(!options.appendtext)
    delete options.appendtext;
  else
    options.appendtext = '\n\n' + applyReplacements(options.appendtext);

  console.log(options);
  return callback(null);

  local.exec('edit', options, useResult);

  function useResult(err, res) {
    if(err)
      return callback(err);
    console.log(res.data);
    // TODO: log
    callback(null);
  }
}

Seq()
  .par(function() {
    console.log('Reading local namespaces');
    readMetaNamespaces(local, this);
  })
  .par(function() {
    console.log('Reading shared namespaces');
    readMetaNamespaces(shared, this);
  })
  .par(function() {
    console.log('Reading config');
    readConfig(config, CONFIG_PAGE, this);
  })
  .seq(function() {
    console.log('Reading credentials');
    askCredentials(credentials, this);
  })
  .seq(function() {
    console.log('Logging in');
    login(cookie, credentials.name, credentials.pass, this);
  })
  .seq(function() {
    var callback = this;
    function askAgain() {
      rl.question('[r]ecent changes/[a]ll images/[Q]uit: ', function(c) {
        if(!c || c[0] === 'q') {
          callback(null)
        } else if(c[0] === 'r') {
          traverseRC(null, callback); // TODO: grcstart
        } else if(c[0] === 'a') {
          traverseAllImages(callback);
        } else {
          askAgain();
        }
      });
    }
    askAgain();
  })
  .seq(function() {
    console.log('shutting down');
    process.exit()
  });
