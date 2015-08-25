#!/usr/bin/env node

var mineos = require('./mineos');
var server = require('./server');
var async = require('async');

var express = require('express');
var passport = require('passport');
var LocalStrategy = require('passport-local');
var passportSocketIO = require("passport.socketio");
var expressSession = require('express-session');
var bodyParser = require('body-parser');
var methodOverride = require('method-override');
var cookieParser = require('cookie-parser');

var sessionStore = new expressSession.MemoryStore();
var app = express();
var http = require('http').Server(app);

var BASE_DIR = '/var/games/minecraft';
var response_options = {root: __dirname};

// Authorization
var localAuth = function (username, password) {
  var Q = require('q');
  var auth = require('./auth');
  var deferred = Q.defer();

  auth.authenticate_shadow(username, password, function(authed_user) {
  	if (authed_user)
		deferred.resolve({ username: authed_user });
	else
		deferred.reject(new Error('incorrect password'));
  })

  return deferred.promise;
}

// Passport init
passport.serializeUser(function(user, done) {
  //console.log("serializing " + user.username);
  done(null, user);
});

passport.deserializeUser(function(obj, done) {
  //console.log("deserializing " + obj);
  done(null, obj);
});

// Use the LocalStrategy within Passport to login users.
passport.use('local-signin', new LocalStrategy(
  {passReqToCallback : true}, //allows us to pass back the request to the callback
  function(req, username, password, done) {
    localAuth(username, password)
    .then(function (user) {
      if (user) {
        console.log('Successful login attempt for username:', username);
        done(null, user);
      }
    })
    .fail(function (err) {
      console.log('Unsuccessful login attempt for username:', username);
      done(null);
    });
  }
));

// clean up sessions that go stale over time
function session_cleanup() {
  //http://stackoverflow.com/a/10761522/1191579
  sessionStore.all(function(err, sessions) {
    for (var i = 0; i < sessions.length; i++) {
      sessionStore.get(sessions[i], function() {} );
    }
  });
}

// Simple route middleware to ensure user is authenticated.
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  req.session.error = 'Please sign in!';
  res.redirect('/admin/login.html');
}

app.use(bodyParser.urlencoded({extended: false}));
app.use(methodOverride());
app.use(expressSession({ 
  secret: 'session_secret', 
  key:'express.sid', 
  store: sessionStore,
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

var io = require('socket.io')(http)
io.use(passportSocketIO.authorize({
  cookieParser: cookieParser,       // the same middleware you registrer in express
  key:          'express.sid',       // the name of the cookie where express/connect stores its session_id
  secret:       'session_secret',    // the session_secret to parse the cookie
  store:        sessionStore        // we NEED to use a sessionstore. no memorystore please
}));

function tally(callback) {
  try {
    var uname = require('uname');
    var urllib = require('urllib');
    urllib.request('http://minecraft.codeemo.com/tally/tally-node.py', {data: uname.uname()}, function(){});
  } catch (e) {
    console.log('MineOS unable to load "uname" module; tally failed.')
  }
}

function read_ini(filepath) {
  var ini = require('ini');
  var fs = require('fs');
  try {
    var data = fs.readFileSync(filepath);
    return ini.parse(data.toString());
  } catch (e) {
    return {};
  }
}

mineos.dependencies(function(err, binaries) {
	if (err) {
		console.log('MineOS is missing dependencies:', err);
		console.log(binaries);
	} else {
		var be = new server.backend(BASE_DIR, io);

    tally();
    setInterval(tally, 7200000); //7200000 == 120min

		app.get('/', function(req, res){
			res.redirect('/admin/index.html');
		});

		app.get('/admin/index.html', ensureAuthenticated, function(req, res){
			res.sendfile('/html/index.html', response_options);
		});

		app.get('/login', function(req, res){
			res.sendfile('/html/login.html');
		});

		app.post('/auth', passport.authenticate('local-signin', {
			successRedirect: '/admin/index.html',
			failureRedirect: '/admin/login.html'
			})
		);

		app.get('/logout', function(req, res){
			req.logout();
			res.redirect('/admin/login.html');
		});

		app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io'));
		app.use('/angular', express.static(__dirname + '/node_modules/angular'));
		app.use('/angular-translate', express.static(__dirname + '/node_modules/angular-translate/dist'));
		app.use('/moment', express.static(__dirname + '/node_modules/moment'));
		app.use('/angular-moment', express.static(__dirname + '/node_modules/angular-moment'));
		app.use('/angular-moment-duration-format', express.static(__dirname + '/node_modules/moment-duration-format/lib'));
		app.use('/admin', express.static(__dirname + '/html'));

		process.on('SIGINT', function() {
			console.log("Caught interrupt signal; closing webui....");
			be.shutdown();
			process.exit();
		});

    var fs = require('fs');
    var mineos_config = read_ini('/etc/mineos.conf');
    var HOSTING_PORT = null;
    var USE_HTTPS = true;

    if ('use_https' in mineos_config)
      USE_HTTPS = mineos_config['use_https'];

    if ('hosting_port' in mineos_config)
      HOSTING_PORT = mineos_config['hosting_port'];
    else
      if (USE_HTTPS)
        HOSTING_PORT = 8443;
      else
        HOSTING_PORT = 8080;

    if (USE_HTTPS)
      async.parallel({
        key: async.apply(fs.readFile, mineos_config['ssl_private_key'] || '/etc/ssl/certs/mineos.key'),
        cert: async.apply(fs.readFile, mineos_config['ssl_certificate'] || '/etc/ssl/certs/mineos.crt')
      }, function(err, ssl) {
        if (err) {
          console.error('Could not locate required SSL files /etc/ssl/certs/mineos.{key,crt}, aborting server start.');
          process.exit(1);
        } else {
          var https = require('https');

          var https_server = https.createServer(ssl, app).listen(HOSTING_PORT);
          io.attach(https_server);
          console.log("MineOS webui listening on *:" + HOSTING_PORT);
        }
      })
    else {
      console.error('mineos.conf set to host insecurely: starting HTTP server.');
      http.listen(HOSTING_PORT, function(){
        console.log('MineOS webui listening on *:' + HOSTING_PORT);
      });
    }

    setInterval(session_cleanup, 3600000); //check for expired sessions every hour
  }
})

