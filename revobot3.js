"use strict";

// builtin
var http = require('http');
var rl = require('readline').createInterface(process.stdin, process.stdout, null);

// npm
var xml2js = new (require('xml2js').Parser);
var Seq = require('seq');

var CONFIG_PAGE = 'User:Forrester/lizenzvorlagen.js';
var API = {
  host: 'de.wikipedia.org',
  port: 80,
  path: '/w/api.php'
};

var PICTURES_IN_PARALLEL = 10;
var TLLIMIT = 'max';
var AILIMIT = 'max';
var GRCLIMIT = 'max';

var credentials = {
  name: null,
  pass: null
};
var cookie = {};
var config = {
  pageid:  null,
  oldid:   null,
  title:   null,
  texts:   {},
  ruleset: {}
};
var namespaces = {};

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
        callback(null, { res: res, data: JSON.parse(allData) });
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
  this.exec = exec;
}

var api = new Api(API, cookie);

function askCredentials(credentials, callback) {
  rl.question('Username: ', function(name) {
    credentials.name = name;
    rl.question('Password [DISPLAYED!!!]: ', function(pass) {
      credentials.pass = pass;
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
      api.exec('login', {
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

  api.exec('login', {
    lgname: name,
    lgpassword: pass
  }, onRes);
}

function readMetaNamespaces(namespaces, callback) {
  api.exec('query', {
    meta: 'siteinfo',
    siprop: 'namespaces'
  }, function(err, res) {
    if(err)
      return callback(err);
    for(var e in res.data.query.namespaces)
      namespaces[e] = res.data.query.namespaces[e]['*'] || null;
    callback(null, namespaces);
  });
}

function readConfig(config, page, callback) {
  function onRes(err, res) {
    if(err)
      return callback(err);

    config.pageid = +res.data.query.pageids[0];
    config.title = res.data.query.pages[config.pageid].title;
    var rev = res.data.query.pages[config.pageid].revisions[0];
    config.oldid = rev.revid;
    xml2js.parseString(rev['*'], function(err, data) {
      if(err)
        return callback(err);

      var el = data.settings.text;
      for(var i = 0; i < el.length; ++i)
        config.texts[ el[i]['@'].type ] = el[i]['#'];

      var el = data.ruleset;
      for(var i = 0; i < el.length; ++i)
        for(var e in el[i])
          if(e !== '@') {
            var datum;
            if('map' in el[i][e])
              datum = el[i][e].map(function(x) {
                return x['@'];
              });
            else
              datum = [ el[i][e]['@'] ];
            var items = {};
            datum.map(function(x) {
              for(var e in x)
                return x[e];
            }).forEach(function(x) {
              items[x] = true;
            });
            config.ruleset[ el[i]['@'].type ] = items;
          }

      callback(null, config);
    });
  }

  api.exec('query', {
    prop:         'revisions',
    rvprop:       'ids|content',
    rvlimit:      1,
    redirects:    true,
    indexpageids: true,
    titles:       page
  }, onRes);
}

function traverseAllImages(callback) {
  function queryAllImages(aifrom) {
    var options = {
      list:    'allimages',
      ailimit: AILIMIT,
      aiprop:  ''
    };
    if(aifrom !== null)
      options.aifrom = aifrom;
    api.exec('query', options, processImages);
  }

  function processImages(err, res) {
    if(err)
      return callback(err);
    Seq(res.data.query.allimages)
      .parEach(PICTURES_IN_PARALLEL, function(image) {
        processImage(image.title, this);
      })
      .seq(function() {
        try {
          if(res.data['query-continue'].allimages.aifrom)
            return queryAllImages(res.data['query-continue'].allimages.aifrom);
        } catch(e) { }
        callback(null);
      });
  }

  queryAllImages(null);
}

function traverseRC(grcstart, callback) {
  function queryRC(grcstart) {
    var options = {
      generator:      'recentchanges',
      redirects:      true,
      indexpageids:   true,
      grcdir:         'newer',
      grcnamespace:   6,
      grcexcludeuser: credentials.name,
      grcshow:        '!redirect',
      grclimit:       GRCLIMIT,
      grctype:        'edit|new',
      grctoponly:     true
    };
    if(grcstart)
      options.grcstart = grcstart;
    api.exec('query', options, processRC);
  }

  function processRC(err, res) {
    if(err)
      return callback(err);
    Seq(res.data.query.pageids)
      .parEach(PICTURES_IN_PARALLEL, function(pageid) {
        processImage(res.data.query.pages[pageid].title, this);
      })
      .seq(function() {
        try {
          if(res.data['query-continue'].recentchanges.grcstart) {
            return queryRC(res.data['query-continue'].recentchanges.grcstart);
          }
        } catch(e) { }
        callback(null);
      });
  }

  queryRC(grcstart);
}

function stripNS(name, ns) {
  if(!namespaces[ns])
    return name;
  else
    return name.substring(namespaces[ns].length + 1);
}

function processImage(title, callback) {
  if(config.ruleset.ignore[stripNS(title, 6)] === true)
    return callback(null);

  function queryTemplates(tlcontinue) {
    var options = {
      prop:         'templates|revisions|info',
      tlnamespace:  10,
      tllimit:      TLLIMIT,
      rvprop:       'timestamp',
      rvlimit:      1,
      inprop:      'protection',
      intoken:     'edit',
      indexpageids: true,
      titles:       title
    };
    if(tlcontinue !== null)
      options.tlcontinue = tlcontinue;
    api.exec('query', options, processTemplates);
  }

  function processTemplates(err, res) {
    if(err)
      return callback(err);

    var imgInfo = res.data.query.pages[ res.data.query.pageids[0] ];
    var template;
    if(imgInfo.templates) {
      while( (template = imgInfo.templates.shift()) ) {
        if(config.ruleset.allow[stripNS(template.title, 10)] === true)
          return callback(null);
      }
    }

    try {
      if(res.data['query-continue'].templates.tlcontinue)
        return queryTemplates(res.data['query-continue'].templates.tlcontinue);
    } catch(e) { }

    editImage(imgInfo, 'false', callback);
  }

  queryTemplates(null);
}

function editImage(imgInfo, type, callback) {
  var options = {
    title:          imgInfo.title,
    basetimestamp:  imgInfo.revisions[0].timestamp,
    starttimestamp: imgInfo.starttimestamp,
    token:          imgInfo.edittoken

    minor:          true,
    bot:            true,
    assert:         'bot',
    nocreate:       true,

    summary:        config.texts[type + ' summary'],
    prependtext:    config.texts[type + ' prepend'],
    appendtext:     config.texts[type + ' append'],
  };

  if(!options.summary)
    return callback(null);

  if(!options.prependtext)
    delete options.prependtext;
  else
    options.prependtext += '\n\n';

  if(!options.appendtext)
    delete options.appendtext;
  else
    options.appendtext = '\n\n' + options.appendtext;

  console.log(options);
  return callback(null);

  api.exec('edit', options, useResult);

  function useResult(err, res) {
    if(err)
      return callback(err);
    console.log(res.data);
    callback(null);
  }
}

Seq()
  .seq(function() {
    console.log('Reading credentials');
    askCredentials(credentials, this);
  })
  .seq(function() {
    console.log('Logging in');
    login(cookie, credentials.name, credentials.pass, this);
  })
  .seq(function() {
    console.log('Reading local namespace aliases');
    readMetaNamespaces(namespaces, this);
  })
  .seq(function() {
    console.log('Reading config');
    readConfig(config, CONFIG_PAGE, this);
  })
  .seq(function() {
    var callback = this;
    (function askAgain() {
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
    })();
  })
  .seq(function() {
    console.log('shutting down');
    process.exit()
  });
